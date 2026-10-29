/**
 * macOS backend: Spotlight (`mdfind`).
 *
 * macOS keeps a system-wide metadata index (Spotlight) that covers every
 * locally indexed volume and updates itself incrementally through FSEvents.
 * Reading APFS raw devices would require root just like NTFS; Spotlight is the
 * platform's equivalent of the Windows MFT index and needs no elevation, which
 * is exactly what the `@file` completion needs on a Mac.
 *
 * The engine takes the same query contract as the local Windows index
 * (`query(text, { max, matchPath, exts })`) so `lib/search.js` can rank both
 * backends identically.
 *
 * @module dsh-everything-file/spotlight-engine
 */

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

/** Default mdfind executable on macOS. */
const DEFAULT_MDFIND = '/usr/bin/mdfind'

/** Named-pipe-like engine result contract shared with the Windows backend. */
export class SpotlightEngine {
  /**
   * @param {object} [options]
   * @param {string} [options.mdfindPath] - executable path (tests inject a path).
   * @param {number} [options.timeoutMs] - per-query timeout.
   * @param {number} [options.cacheTtlMs] - repeated-query cache lifetime.
   * @param {(args: string[], timeoutMs: number) => Promise<{ stdout: string }>} [options.run] - command runner (tests).
   * @param {{ warn: (...args: unknown[]) => void }} [options.logger]
   */
  constructor(options = {}) {
    this.kind = 'spotlight'
    this.mdfindPath = options.mdfindPath ?? DEFAULT_MDFIND
    this.timeoutMs = options.timeoutMs ?? 5000
    this.cacheTtlMs = options.cacheTtlMs ?? 1500
    this.run = options.run ?? ((args, timeoutMs) => runMdfind(this.mdfindPath, args, timeoutMs))
    this.logger = options.logger
    this.cache = new Map()
    this.cacheLimit = 120
    this.disposed = false
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
   * @returns {Promise<{ rows: Array<{ path: string, folder: boolean }>, error?: { code: number, message: string } }>}
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
    const clauses = scanTokens
      .filter(token => token.length > 0)
      .map(token => `kMDItemFSName == "*${escapeSpotlight(token)}*"cd`)
    for (const ext of exts) {
      const clean = ext.replace(/^\./, '')
      if (/^[\p{L}\p{N}_-]+$/u.test(clean)) clauses.push(`kMDItemFSName == "*.${clean}"cd`)
    }
    if (clauses.length === 0) return { rows: [] }

    let stdout
    try {
      const result = await this.run([clauses.join(' && ')], clampInt(options.timeoutMs ?? this.timeoutMs, 500, 30000))
      stdout = result.stdout
    } catch (error) {
      return { rows: [], error: { code: 2, message: `mdfind failed: ${error instanceof Error ? error.message : String(error)}` } }
    }

    const normalizedPath = String(text ?? '').trim().replaceAll('\\', '/').toLowerCase()
    const rows = []
    const seen = new Set()
    for (const line of stdout.split('\n')) {
      const path = line.trim()
      if (path.length === 0 || seen.has(path)) continue
      seen.add(path)
      const name = path.slice(path.lastIndexOf('/') + 1)
      // A path query is validated against the resolved path; a plain query is
      // an AND over the file name.
      if (matchPath) {
        if (!path.toLowerCase().includes(normalizedPath)) continue
      } else if (!matchesAllTokens(name, tokens)) {
        continue
      }
      if (exts.length > 0 && !endsWithExtension(name, exts)) continue
      // mdfind can report paths removed since the last index update.
      if (!existsSync(path)) continue
      rows.push({ path, folder: isDirectory(path) })
      if (rows.length >= max) break
    }
    this.#remember(cacheKey, rows)
    return { rows }
  }

  /**
   * Spotlight has no cheap "recently modified, ordered" query; the empty-query
   * page stays empty on macOS instead of paying one `mdls` per candidate.
   * @returns {Promise<{ rows: Array<{ path: string, folder: boolean }> }>}
   */
  async recent() {
    return { rows: [] }
  }

  /** Whether `mdfind` is available (i.e. Spotlight is installed). */
  async status() {
    return { running: existsSync(this.mdfindPath) }
  }

  /** Drop caches; the process owns no child process between queries. */
  dispose() {
    this.disposed = true
    this.cache.clear()
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

/** Run mdfind and collect stdout. */
function runMdfind(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error)
      else resolve({ stdout })
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

/** True when the base name ends with one of the requested extensions. */
function endsWithExtension(name, exts) {
  const lower = name.toLowerCase()
  for (const ext of exts) {
    if (lower.endsWith(`.${ext.replace(/^\./, '').toLowerCase()}`)) return true
  }
  return false
}

/** Case-insensitive AND over the visible name. */
function matchesAllTokens(name, tokens) {
  const lower = name.toLowerCase()
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
