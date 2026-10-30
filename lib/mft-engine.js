/**
 * Client for the local `dsh-mft-index` Windows service.
 *
 * The service reads the NTFS MFT of every fixed volume and keeps the file
 * names in memory, so the Harness plugin itself never needs elevation and
 * never needs a third-party index service installed. This module owns the named-pipe
 * connection, request serialization (the service answers one connection at a
 * time per client), short-lived result caching, and transparent reconnects.
 *
 * @module dsh-everything-file/mft-engine
 */

import net from 'node:net'
import { performance } from 'node:perf_hooks'

const INDEX_UNAVAILABLE = 2
const BUILDING = 6

/**
 * @typedef {object} MftRow
 * @property {string} path - native Windows path.
 * @property {boolean} folder
 */

/** Named-pipe client for the local NTFS index service. */
export class MftIndexEngine {
  /**
   * @param {object} options
   * @param {string} [options.pipeName] - service pipe name without the prefix.
   * @param {number} [options.timeoutMs] - per-request timeout.
   * @param {number} [options.cacheTtlMs] - repeated-query cache lifetime.
   * @param {{ warn: (...args: unknown[]) => void }} [options.logger]
   */
  constructor(options = {}) {
    this.kind = 'mft'
    this.pipeName = options.pipeName ?? 'dsh-mft-index'
    this.pipePath = `\\\\.\\pipe\\${this.pipeName}`
    this.timeoutMs = options.timeoutMs ?? 2000
    this.cacheTtlMs = options.cacheTtlMs ?? 1500
    this.logger = options.logger
    this.socket = undefined
    this.reader = undefined
    this.pending = undefined
    this.buffer = ''
    this.current = undefined
    this.nextId = 1
    this.running = false
    this.waiting = undefined
    this.cache = new Map()
    this.cacheLimit = 160
    this.disposed = false
  }

  /**
   * Query the index with name/path text.
   * @param {string} text - lower-cased or mixed-case text; the service lowercases.
   * @param {object} [options]
   * @param {number} [options.max]
   * @param {boolean} [options.matchPath]
   * @param {string[]} [options.exts]
   * @param {number} [options.timeoutMs]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{ rows: MftRow[], error?: { code: number, message: string } }>}
   */
  async query(text, options = {}) {
    if (this.disposed) return { rows: [], error: { code: 9, message: 'index client disposed' } }
    if (options.signal?.aborted) return { rows: [] }
    const max = clampInt(options.max ?? 300, 1, 2000)
    const matchPath = options.matchPath === true
    const exts = Array.isArray(options.exts) ? options.exts.filter(Boolean).slice(0, 8) : []
    const cacheKey = `${matchPath ? 1 : 0}|${max}|${exts.join(',')}|${text}`
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined && performance.now() - cached.at < this.cacheTtlMs) {
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cached)
      return { rows: cached.rows }
    }
    const payload = `${max}\t${matchPath ? 1 : 0}\t${Buffer.from(text, 'utf8').toString('base64')}\t${Buffer.from(exts.join(','), 'utf8').toString('base64')}`
    const result = await this.#enqueue(`QUERY\t${payload}`, options.timeoutMs)
    if (result.error === undefined) this.#remember(cacheKey, result.rows)
    return { rows: result.rows, error: result.error }
  }

  /** Recently modified files across the indexed volumes. */
  async recent(max = 20, options = {}) {
    if (this.disposed) return { rows: [], error: { code: 9, message: 'index client disposed' } }
    const result = await this.#enqueue(`RECENT\t${clampInt(max, 1, 2000)}`, options.timeoutMs)
    return { rows: result.rows, error: result.error }
  }

  /**
   * Service status for diagnostics and backend selection.
   * @returns {Promise<{ running: boolean, ready?: boolean, entries?: number, building?: boolean, buildMs?: number, source?: string, error?: { code: number, message: string } }>}
   */
  async status() {
    if (this.disposed) return { running: false, error: { code: 9, message: 'index client disposed' } }
    const result = await this.#enqueue('STATUS', 1200)
    if (result.error !== undefined) return { running: false, error: result.error }
    return { running: true, ...result.status }
  }

  /** Close the pipe and drop cached results. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.cache.clear()
    this.#stop()
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

  #enqueue(body, timeoutMs) {
    return new Promise(resolve => {
      if (!this.running) {
        this.running = true
        this.#execute(body, timeoutMs).then(result => {
          this.running = false
          resolve(result)
          this.#drain()
        })
        return
      }
      if (this.waiting !== undefined) this.waiting.resolve({ rows: [], superseded: true })
      this.waiting = { body, timeoutMs, resolve }
    })
  }

  #drain() {
    const next = this.waiting
    this.waiting = undefined
    if (next === undefined || this.disposed) {
      if (next !== undefined) next.resolve({ rows: [], superseded: true })
      return
    }
    this.running = true
    this.#execute(next.body, next.timeoutMs).then(result => {
      this.running = false
      next.resolve(result)
      this.#drain()
    })
  }

  #execute(body, timeoutMs) {
    let socket
    try {
      socket = this.#ensureSocket()
    } catch (error) {
      return Promise.resolve({
        rows: [],
        error: { code: INDEX_UNAVAILABLE, message: error instanceof Error ? error.message : String(error) },
      })
    }
    const id = String(this.nextId++)
    const limit = timeoutMs ?? this.timeoutMs
    return new Promise(resolve => {
      const entry = { id, resolve, rows: [], timer: undefined, done: false }
      entry.timer = setTimeout(() => {
        if (entry.done) return
        entry.done = true
        this.pending = undefined
        this.current = undefined
        this.#stop()
        resolve({ rows: [], error: { code: 100, message: `index query timed out after ${limit} ms` } })
      }, limit)
      this.pending = entry
      try {
        socket.write(`${id}\t${body}\n`)
      } catch (error) {
        this.#settle(entry, { rows: [], error: { code: 9, message: String(error) } })
      }
    })
  }

  #ensureSocket() {
    if (this.socket !== undefined) return this.socket
    const socket = net.connect(this.pipePath)
    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    socket.on('data', chunk => this.#onData(chunk))
    socket.on('error', error => this.#abortAll({ code: INDEX_UNAVAILABLE, message: `index service connection failed: ${error.message}` }))
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.reader = undefined
      this.#abortAll({ code: INDEX_UNAVAILABLE, message: 'index service connection closed' })
    })
    this.socket = socket
    return socket
  }

  #onData(chunk) {
    this.buffer += chunk
    let newline
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.#onLine(line)
    }
  }

  #onLine(line) {
    const parts = line.split('\t')
    // Result rows carry no request id; they belong to the in-flight query.
    if (this.current !== undefined && (parts[0] === 'F' || parts[0] === 'D')) {
      this.current.rows.push({ folder: parts[0] === 'D', path: parts.slice(1).join('\t') })
      return
    }
    const entry = this.pending
    if (entry === undefined || entry.id !== parts[0]) return
    if (parts[1] === 'OK') {
      if (Number(parts[2]) === 0) {
        this.#settle(entry, { rows: [] })
      } else {
        this.current = entry
      }
      return
    }
    if (parts[1] === 'END') {
      const rows = this.current === entry ? entry.rows : []
      this.current = undefined
      this.#settle(entry, { rows })
      return
    }
    if (parts[1] === 'ERR') {
      this.current = undefined
      this.#settle(entry, { rows: [], error: { code: Number(parts[2]) || 9, message: parts[3] ?? 'index query failed' } })
      return
    }
    if (parts[1] === 'STATUS') {
      this.#settle(entry, {
        rows: [],
        status: {
          ready: parts[2] === '1',
          entries: Number(parts[3]) || 0,
          building: parts[4] === '1',
          buildMs: Number(parts[5]) || 0,
          source: parts[6],
        },
      })
    }
  }

  #settle(entry, result) {
    if (entry.done) return
    entry.done = true
    clearTimeout(entry.timer)
    if (this.pending === entry) this.pending = undefined
    if (this.current === entry) this.current = undefined
    entry.resolve(result)
  }

  #abortAll(error) {
    const entry = this.pending
    this.pending = undefined
    this.current = undefined
    if (entry !== undefined) this.#settle(entry, { rows: [], error })
    if (this.waiting !== undefined) {
      const waiting = this.waiting
      this.waiting = undefined
      waiting.resolve({ rows: [], error })
    }
  }

  #stop() {
    const socket = this.socket
    this.socket = undefined
    this.buffer = ''
    this.pending = undefined
    this.current = undefined
    if (socket !== undefined) {
      try {
        socket.destroy()
      } catch {
        // Already gone.
      }
    }
  }
}

/** One index request outcome. */
/**
 * @typedef {object} IndexResult
 * @property {MftRow[]} rows
 * @property {{ code: number, message: string }} [error]
 * @property {{ ready: boolean, entries: number, building: boolean, buildMs: number, source?: string }} [status]
 */

/** @param {unknown} value @param {number} min @param {number} max */
function clampInt(value, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : min
  return number < min ? min : number > max ? max : number
}

export { INDEX_UNAVAILABLE, BUILDING }
