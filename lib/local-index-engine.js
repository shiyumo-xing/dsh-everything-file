/**
 * Cross-platform local index client.
 *
 * Starts `local-index-worker.js` on demand, forwards name queries to the
 * in-memory index it builds, and reports build progress. This backend needs no
 * administrator rights, no external service, and no native binary, so a fresh
 * install works on Windows, macOS, and Linux. It is slower to build initially
 * than the Windows MFT service or Spotlight, so `auto` uses those first when
 * they are available.
 *
 * @module dsh-everything-file/local-index-engine
 */

import { Worker } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'

const WORKER_URL = new URL('./local-index-worker.js', import.meta.url)

/** Portable walk-index backend. */
export class LocalIndexEngine {
  /**
   * @param {object} [options]
   * @param {string[]} [options.roots] - roots to index; empty means platform defaults.
   * @param {string[]} [options.excludes] - absolute prefixes to skip.
   * @param {number} [options.maxEntries] - hard cap.
   * @param {number} [options.refreshMinutes] - periodic full refresh (0 disables).
   * @param {number} [options.timeoutMs] - per-request timeout.
   * @param {{ warn: (...args: unknown[]) => void }} [options.logger]
   */
  constructor(options = {}) {
    this.kind = 'local'
    this.roots = Array.isArray(options.roots) ? options.roots : []
    this.excludes = Array.isArray(options.excludes) ? options.excludes : []
    this.maxEntries = options.maxEntries ?? 12000000
    this.refreshMinutes = options.refreshMinutes ?? 15
    this.timeoutMs = options.timeoutMs ?? 8000
    this.logger = options.logger
    this.worker = undefined
    this.pending = new Map()
    this.nextId = 1
    this.cache = new Map()
    this.cacheLimit = 120
    this.lastStatus = undefined
    this.refreshTimer = undefined
    this.disposed = false
  }

  /**
   * Query the walk index.
   * @param {string} text
   * @param {object} [options]
   * @returns {Promise<{ rows: Array<{ path: string, folder: boolean }>, error?: { code: number, message: string } }>}
   */
  async query(text, options = {}) {
    if (this.disposed) return { rows: [], error: { code: 9, message: 'local index disposed' } }
    if (options.signal?.aborted) return { rows: [] }
    const max = clampInt(options.max ?? 300, 1, 2000)
    const matchPath = options.matchPath === true
    const exts = Array.isArray(options.exts) ? options.exts.filter(Boolean).slice(0, 8) : []
    const cacheKey = `${matchPath ? 1 : 0}|${max}|${exts.join(',')}|${text}`
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined && performance.now() - cached.at < 1500) {
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cached)
      return { rows: cached.rows }
    }
    try {
      const reply = await this.#request({ type: 'query', text, max, matchPath, exts }, options.timeoutMs ?? this.timeoutMs)
      const rows = Array.isArray(reply.rows) ? reply.rows : []
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, { rows, at: performance.now() })
      while (this.cache.size > this.cacheLimit) {
        const oldest = this.cache.keys().next()
        if (oldest.done === true) break
        this.cache.delete(oldest.value)
      }
      return { rows }
    } catch (error) {
      return { rows: [], error: { code: 2, message: error instanceof Error ? error.message : String(error) } }
    }
  }

  /** The walk index has no maintained recent list. */
  async recent() {
    return { rows: [] }
  }

  /**
   * Build progress and entry count.
   * @returns {Promise<{ running: boolean, ready?: boolean, building?: boolean, entries?: number, buildMs?: number, roots?: string[], truncated?: boolean, error?: { code: number, message: string } }>}
   */
  async status() {
    if (this.disposed) return { running: false, error: { code: 9, message: 'local index disposed' } }
    try {
      this.#ensureWorker()
      const reply = await this.#request({ type: 'status' }, 3000)
      return { running: true, ...(reply.status ?? {}) }
    } catch (error) {
      return { running: false, error: { code: 2, message: error instanceof Error ? error.message : String(error) } }
    }
  }

  /** Ask the worker to rebuild from its roots. */
  async rebuild() {
    if (this.disposed) return
    try {
      await this.#request({ type: 'rebuild' }, 3000)
    } catch (error) {
      this.logger?.warn?.(`dsh-everything-file: local index rebuild failed: ${String(error)}`)
    }
  }

  /** Last known status without starting a worker (for diagnostics). */
  peekStatus() {
    if (this.lastStatus === undefined) return { running: false }
    return { running: true, ...this.lastStatus }
  }

  /** Stop the worker and drop caches. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.cache.clear()
    if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer)
    this.refreshTimer = undefined
    const worker = this.worker
    this.worker = undefined
    if (worker !== undefined) {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error('local index disposed'))
      }
      this.pending.clear()
      void worker.terminate()
    }
  }

  #ensureWorker() {
    if (this.worker !== undefined) return this.worker
    if (this.disposed) throw new Error('local index disposed')
    const worker = new Worker(WORKER_URL, {
      workerData: {
        roots: this.roots,
        excludes: this.excludes,
        maxEntries: this.maxEntries,
      },
    })
    worker.on('message', message => this.#onMessage(message))
    worker.on('error', error => {
      this.logger?.warn?.(`dsh-everything-file: local index worker error: ${error.message}`)
      this.#failAll(new Error(`local index worker error: ${error.message}`))
    })
    worker.on('exit', code => {
      if (this.worker !== worker) return
      this.worker = undefined
      this.#failAll(new Error(`local index worker exited (${code})`))
    })
    this.worker = worker
    if (this.refreshMinutes > 0) {
      this.refreshTimer = setInterval(() => {
        void this.rebuild()
      }, this.refreshMinutes * 60 * 1000)
      this.refreshTimer.unref?.()
    }
    return worker
  }

  #onMessage(message) {
    if (message === null || typeof message !== 'object') return
    if (message.type === 'ready' || message.type === 'progress') {
      this.lastStatus = {
        ready: message.type === 'ready',
        building: message.type === 'progress',
        entries: message.entries,
        buildMs: message.buildMs,
        truncated: message.truncated,
        roots: message.roots,
      }
      return
    }
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.type === 'error') entry.reject(new Error(message.message))
    else entry.resolve(message)
  }

  #request(message, timeoutMs) {
    const worker = this.#ensureWorker()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`local index request timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        worker.postMessage({ ...message, id })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  #failAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}

/** @param {unknown} value @param {number} min @param {number} max */
function clampInt(value, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : min
  return number < min ? min : number > max ? max : number
}
