/**
 * macOS backend: Spotlight (`mdfind`).
 *
 * macOS keeps a system-wide metadata index (Spotlight) that covers every
 * locally indexed volume and updates itself incrementally through FSEvents.
 * Reading APFS raw devices would require root just like NTFS; Spotlight is the
 * platform's equivalent of the Windows MFT index and needs no elevation, which
 * is exactly what the `@file` completion needs on a Mac.
 *
 * `mdfind` is a process, and one wildcard query is a metadata scan that costs
 * 100 ms-5 s: a picker that issues one query per keystroke cannot simply spawn
 * them all: the Windows MFT client serializes and coalesces because its SDK
 * allows only one IPC query at a time; Spotlight has the same constraint for a
 * different reason — every query queues inside `mds`, so ten concurrent scans of
 * a half-typed word make the last one exceed its timeout and render nothing.
 * This engine therefore keeps one `mdfind` in flight, lets a *different* newer
 * query replace the waiting one (killing the superseded child so `mds` spends
 * its time on the characters the user actually has on screen), and makes every
 * request for the *same* query join the scan already queued or running. The join
 * is not an optimization: the picker re-asks for one text as its caret and spans
 * settle, and a scheduler that treated those repeats as supersessions kept
 * killing the only scan that could answer them — new words then returned nothing
 * while recently answered ones (cache) still appeared. A joined scan is only
 * cancelled once every caller that is still waiting has gone away.
 *
 * It also stops a single scan as soon as it has enough rows, which bounds the
 * cost of a very common term (`*a*` matches most of the disk).
 *
 * The engine takes the same query contract as the local Windows index
 * (`query(text, { max, matchPath, exts })`) so `lib/search.js` can rank both
 * backends identically.
 *
 * @module dsh-everything-file/spotlight-engine
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

/** Default mdfind executable on macOS. */
const DEFAULT_MDFIND = '/usr/bin/mdfind'

/** Per-query deadline; a scan past this is dropped rather than shown late. */
const DEFAULT_TIMEOUT_MS = 5000

/** Repeated-query cache lifetime: one glyph's worth of typing. */
const DEFAULT_CACHE_TTL_MS = 1500

/** The empty-`@` page changes slowly; a shorter cache would only add scans. */
const DEFAULT_RECENT_TTL_MS = 30000

/** Recently modified paths, for the empty-query page (mirrors the Windows one). */
const RECENT_PREDICATE = 'kMDItemFSContentChangeDate >= $time.today(-1)'

/** Refuse to buffer an unbounded result list (each row is one path). */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/** Result for a request replaced by a newer one before it ran. */
const SUPERSEDED = Object.freeze({ rows: [], superseded: true })

/**
 * Spotlight-backed file index.
 *
 * Requests are serialized into one `mdfind` slot; a newer request replaces the
 * waiting one and aborts the running child, so a fast typist pays one scan for
 * the sequence instead of one scan per keystroke.
 */
export class SpotlightEngine {
  /**
   * @param {object} [options]
   * @param {string} [options.mdfindPath] - executable path (tests inject a path).
   * @param {number} [options.timeoutMs] - per-query timeout.
   * @param {number} [options.cacheTtlMs] - repeated-query cache lifetime.
   * @param {number} [options.recentCacheTtlMs] - empty-query page cache lifetime.
   * @param {(args: string[], timeoutMs: number, runOptions?: { signal?: AbortSignal, maxLines?: number }) => Promise<{ stdout: string }>} [options.run] - command runner (tests).
   * @param {{ warn: (...args: unknown[]) => void }} [options.logger]
   */
  constructor(options = {}) {
    this.kind = 'spotlight'
    this.mdfindPath = options.mdfindPath ?? DEFAULT_MDFIND
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.recentCacheTtlMs = options.recentCacheTtlMs ?? DEFAULT_RECENT_TTL_MS
    this.run = options.run ?? ((args, timeoutMs, runOptions) => runMdfind(this.mdfindPath, args, timeoutMs, runOptions))
    this.logger = options.logger
    this.cache = new Map()
    this.cacheLimit = 120
    this.recentCache = undefined
    this.disposed = false
    /** Newest request waiting for the single `mdfind` slot. */
    this.waiting = undefined
    /** Request record of the running `mdfind`, when one is running. */
    this.activeRequest = undefined
    /** Abort controller of the running `mdfind`. */
    this.activeController = undefined
    /** Queued-or-running request per query key, so one query never scans twice. */
    this.pendingByKey = new Map()
    /** Whether the pump loop is running. */
    this.running = false
  }

  /**
   * Query Spotlight for file names matching every token.
   * @param {string} text - whitespace-separated name terms.
   * @param {object} [options]
   * @param {number} [options.max]
   * @param {boolean} [options.matchPath]
   * @param {string[]} [options.exts]
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<{ rows: Array<{ path: string, folder: boolean }>, error?: { code: number, message: string }, superseded?: boolean }>}
   */
  async query(text, options = {}) {
    if (this.disposed) return { rows: [], error: { code: 9, message: 'Spotlight backend disposed' } }
    if (options.signal?.aborted) return { rows: [] }
    const max = clampInt(options.max ?? 300, 1, 2000)
    const matchPath = options.matchPath === true
    const exts = Array.isArray(options.exts) ? options.exts.filter(Boolean).slice(0, 8) : []
    const tokens = String(text ?? '').trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return { rows: [] }
    const cacheKey = `${matchPath ? 1 : 0}|${max}|${exts.join(',')}|${tokens.join(' ')}`
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined && performance.now() - cached.at < this.cacheTtlMs) {
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cached)
      return { rows: cached.rows }
    }

    const scanTokens = matchPath ? [lastPathSegment(tokens.join(' '))] : tokens
    const predicate = buildPredicate(scanTokens, exts)
    if (predicate === undefined) return { rows: [] }

    const result = await this.#enqueue({
      type: 'name',
      cacheKey,
      predicate,
      max,
      tokens,
      matchPath,
      exts,
      normalizedPath: matchPath ? String(text ?? '').trim().normalize('NFC').replaceAll('\\', '/').toLowerCase() : '',
      timeoutMs: clampInt(options.timeoutMs ?? this.timeoutMs, 500, 30000),
      signal: options.signal,
    })
    // Empty answers are never cached: a directory the user just created (or a
    // file Spotlight indexed a second later) must appear on the next keystroke,
    // and a superseded scan's emptiness says nothing about the query.
    if (result.error !== undefined || result.superseded === true) return result
    const rows = result.rows
    if (rows.length > 0) this.#remember(cacheKey, rows)
    return { rows }
  }

  /**
   * Recently modified paths for the empty-query page.
   *
   * Spotlight cannot sort, so the rows are ordered here by modification time
   * after one `stat` each. The scan is bounded to the last day of changes, which
   * keeps the predicate cheap on an active machine.
   * @param {number} [max] - rows to return.
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<{ rows: Array<{ path: string, folder: boolean }>, error?: { code: number, message: string } }>}
   */
  async recent(max = 300, options = {}) {
    if (this.disposed) return { rows: [] }
    const limit = clampInt(max, 1, 2000)
    const cached = this.recentCache
    if (cached !== undefined && cached.rows.length >= limit && performance.now() - cached.at < this.recentCacheTtlMs) {
      return { rows: cached.rows.slice(0, limit) }
    }
    const result = await this.#enqueue({
      type: 'recent',
      cacheKey: `recent|${limit}`,
      predicate: RECENT_PREDICATE,
      max: limit,
      timeoutMs: clampInt(options.timeoutMs ?? this.timeoutMs, 500, 30000),
      signal: options.signal,
    })
    if (result.error !== undefined || result.superseded === true) return result
    this.recentCache = { rows: result.rows, at: performance.now() }
    return { rows: result.rows.slice(0, limit) }
  }

  /** Whether `mdfind` is available (i.e. Spotlight is installed). */
  async status() {
    return { running: existsSync(this.mdfindPath) }
  }

  /** Drop caches, kill any child, and refuse later queries. */
  dispose() {
    this.disposed = true
    this.cache.clear()
    this.recentCache = undefined
    this.waiting = undefined
    for (const request of this.pendingByKey.values()) this.#finish(request, SUPERSEDED)
    this.activeController?.abort()
    this.activeController = undefined
    this.activeRequest = undefined
  }

  /**
   * Queue one request behind the running `mdfind`.
   *
   * A request for the *same* query as one already queued or running joins it
   * instead of replacing it: the picker re-asks for one text as its caret and
   * spans settle, and treating those repeats as supersessions killed the only
   * scan that could ever have answered them. A request for a *different* query
   * replaces the waiting one and kills the running scan.
   * @param {object} request
   * @returns {Promise<{ rows: any[], error?: { code: number, message: string }, superseded?: boolean }>}
   */
  #enqueue(request) {
    const shared = this.pendingByKey.get(request.cacheKey)
    if (shared !== undefined) return shared.promise
    const promise = new Promise(resolve => {
      request.resolve = resolve
    })
    request.promise = promise
    this.pendingByKey.set(request.cacheKey, request)
    const replaced = this.waiting
    this.waiting = request
    if (replaced !== undefined) this.#finish(replaced, SUPERSEDED)
    // A superseded scan keeps `mds` busy for up to its whole timeout, which is
    // exactly what made the newest query late. Killing the client ends it.
    this.activeController?.abort()
    if (!this.running) void this.#pump()
    return promise
  }

  /** Resolve one request and forget it as the answer for its query. */
  #finish(request, result) {
    if (this.pendingByKey.get(request.cacheKey) === request) this.pendingByKey.delete(request.cacheKey)
    request.resolve(result)
  }

  /** Run queued requests one at a time until the queue is empty. */
  async #pump() {
    if (this.running) return
    this.running = true
    try {
      while (this.waiting !== undefined && !this.disposed) {
        const request = this.waiting
        this.waiting = undefined
        this.#finish(request, await this.#execute(request))
      }
    } finally {
      this.running = false
      this.activeController = undefined
      this.activeRequest = undefined
    }
  }

  /**
   * Run one request against `mdfind`, bounded by the line budget, the timeout,
   * a superseding query, and `dispose()`.
   *
   * A caller's own abort does not cancel the scan (see the module doc); the
   * controller exists for supersede and `dispose()`.
   * @param {object} request
   */
  async #execute(request) {
    const controller = new AbortController()
    this.activeController = controller
    this.activeRequest = request
    try {
      const maxLines = request.type === 'recent'
        ? Math.min(4000, Math.max(400, request.max * 3))
        : Math.min(20000, Math.max(600, request.max * 6))
      const result = await this.run([request.predicate], request.timeoutMs, {
        signal: controller.signal,
        maxLines,
      })
      if (controller.signal.aborted) return { rows: [] }
      const stdout = String(result?.stdout ?? '')
      const rows = request.type === 'recent'
        ? recentRows(stdout, request.max)
        : matchRows(stdout, request)
      return { rows }
    } catch (error) {
      if (controller.signal.aborted) return { rows: [] }
      const message = error instanceof Error ? error.message : String(error)
      return { rows: [], error: { code: 2, message: `mdfind failed: ${message}` } }
    } finally {
      if (this.activeController === controller) {
        this.activeController = undefined
        this.activeRequest = undefined
      }
    }
  }

  #remember(key, rows) {
    this.cache.delete(key)
    this.cache.set(key, { rows, at: performance.now() })
    while (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next()
      if (oldest.done === true) break
      this.cache.delete(oldest.value)
    }
  }
}

/**
 * Build the Spotlight predicate for one lookup.
 *
 * Every token becomes a name clause. A term with decomposable characters (an
 * accented Latin word, the usual macOS `é` vs `e` + combining acute case) also
 * gets its NFC and NFD spellings, because `mds` indexes the NFD form while the
 * picker sends whatever the keyboard produced.
 *
 * A single ASCII character is the one query worth spelling differently:
 * `*a*` scans a large part of the index and routinely exceeds the query timeout,
 * while `a*` is answered from the term index in a few milliseconds. Typing one
 * letter is a prefix lookup in practice, so that is what it becomes.
 * @param {string[]} tokens
 * @param {string[]} exts
 * @returns {string | undefined}
 */
function buildPredicate(tokens, exts) {
  const clauses = []
  const plain = tokens.filter(token => token.length > 0)
  const prefixOnly = plain.length === 1 && plain[0].length === 1 && /^[\x20-\x7e]$/.test(plain[0])
  for (const token of plain) {
    const variants = [...new Set([token, token.normalize('NFC'), token.normalize('NFD')])]
    const nameClauses = variants.map(variant => {
      const escaped = escapeSpotlight(variant)
      return prefixOnly
        ? `kMDItemFSName == "${escaped}*"cd`
        : `kMDItemFSName == "*${escaped}*"cd`
    })
    clauses.push(nameClauses.length === 1 ? nameClauses[0] : `(${nameClauses.join(' || ')})`)
  }
  for (const ext of exts) {
    const clean = ext.replace(/^\./, '')
    if (/^[\p{L}\p{N}_-]+$/u.test(clean)) clauses.push(`kMDItemFSName == "*.${clean}"cd`)
  }
  if (clauses.length === 0) return undefined
  return clauses.join(' && ')
}

/**
 * Turn one name query's stdout into rows, keeping only paths whose visible name
 * still matches after normalization and whose extension and path filters hold.
 * @param {string} stdout
 * @param {{ max: number, tokens: string[], matchPath: boolean, exts: string[], normalizedPath: string }} request
 */
function matchRows(stdout, request) {
  const rows = []
  const seen = new Set()
  const tokens = request.tokens.map(token => token.normalize('NFC'))
  for (const line of stdout.split('\n')) {
    const path = line.trim()
    if (path.length === 0 || seen.has(path)) continue
    seen.add(path)
    const name = path.slice(path.lastIndexOf('/') + 1)
    // A path query is validated against the resolved path; a plain query is
    // an AND over the file name.
    if (request.matchPath) {
      if (!normalizePath(path).includes(request.normalizedPath)) continue
    } else if (!matchesAllTokens(name, tokens)) {
      continue
    }
    if (request.exts.length > 0 && !endsWithExtension(name, request.exts)) continue
    // mdfind can report paths removed since the last index update.
    if (!existsSync(path)) continue
    rows.push({ path, folder: isDirectory(path) })
    if (rows.length >= request.max) break
  }
  return rows
}

/**
 * Turn the recently-changed query's stdout into rows ordered by modification
 * time, newest first.
 * @param {string} stdout
 * @param {number} max
 */
function recentRows(stdout, max) {
  const entries = []
  const seen = new Set()
  for (const line of stdout.split('\n')) {
    const path = line.trim()
    if (path.length === 0 || seen.has(path)) continue
    seen.add(path)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    entries.push({ path, folder: stat.isDirectory(), at: stat.mtimeMs })
  }
  entries.sort((left, right) => right.at - left.at)
  return entries.slice(0, max).map(({ path, folder }) => ({ path, folder }))
}

/**
 * Run mdfind, collecting stdout until it exits, the line budget is reached, the
 * deadline passes, or the caller aborts.
 * @param {string} command
 * @param {string[]} args
 * @param {number} timeoutMs
 * @param {{ signal?: AbortSignal, maxLines?: number }} [options]
 * @returns {Promise<{ stdout: string }>}
 */
function runMdfind(command, args, timeoutMs, options = {}) {
  const signal = options.signal
  const maxLines = Number.isFinite(options.maxLines) ? Math.max(0, Math.trunc(options.maxLines)) : 0
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      resolve({ stdout: '' })
      return
    }
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }

    const parts = []
    let bytes = 0
    let lines = 0
    let stderr = ''
    let failure
    let stopped = false
    let settled = false

    const stop = () => {
      stopped = true
      // Ask first: a terminated `mdfind` closes its query cleanly, while a
      // SIGKILL leaves `mds` to notice the peer vanished mid-scan. Escalate only
      // when the child ignores the request.
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
      const hard = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }, 150)
      hard.unref?.()
    }
    const settle = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const stdout = parts.join('')
      if (failure === undefined) resolve({ stdout })
      else reject(failure)
    }
    const onAbort = () => {
      // The caller no longer cares about this result; end the scan and let the
      // queue move on to the newer one.
      failure = new Error('mdfind aborted')
      stop()
      settle()
    }

    const timer = setTimeout(() => {
      failure = new Error(`mdfind timed out after ${timeoutMs} ms`)
      stop()
    }, Math.max(1, timeoutMs))

    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      parts.push(chunk)
      bytes += chunk.length
      for (let index = chunk.indexOf('\n'); index >= 0; index = chunk.indexOf('\n', index + 1)) lines += 1
      if ((maxLines > 0 && lines >= maxLines) || bytes >= MAX_OUTPUT_BYTES) stop()
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      if (stderr.length < 512) stderr = `${stderr}${chunk}`.slice(0, 512)
    })
    child.on('error', error => {
      failure = error
      settle()
    })
    child.on('close', code => {
      if (failure === undefined && !stopped && code !== 0) {
        failure = new Error(`mdfind exited with code ${code}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`)
      }
      settle()
    })
  })
}

/** Escape the characters Spotlight query syntax treats specially in a string. */
function escapeSpotlight(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

/** Last segment of a typed path. */
function lastPathSegment(value) {
  const normalized = value.replaceAll('\\', '/')
  const index = normalized.lastIndexOf('/')
  return index < 0 ? normalized : normalized.slice(index + 1)
}

/** Path text compared against a typed path, normalized for composed accents. */
function normalizePath(path) {
  return path.normalize('NFC').replaceAll('\\', '/').toLowerCase()
}

/** True when the base name ends with one of the requested extensions. */
function endsWithExtension(name, exts) {
  const lower = name.toLowerCase()
  for (const ext of exts) {
    if (lower.endsWith(`.${ext.replace(/^\./, '').toLowerCase()}`)) return true
  }
  return false
}

/**
 * Case-insensitive AND over the visible name.
 *
 * Both sides are composed first: `mds` reports names in the decomposed form
 * macOS stores, and an accent typed on the keyboard arrives composed.
 * @param {string} name
 * @param {string[]} tokens - already normalized tokens.
 */
function matchesAllTokens(name, tokens) {
  const lower = name.normalize('NFC').toLowerCase()
  return tokens.every(token => lower.includes(token.toLowerCase()))
}

/** Cheap directory probe (mdfind may return folders too). */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** @param {unknown} value @param {number} min @param {number} max */
function clampInt(value, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : min
  return number < min ? min : number > max ? max : number
}
