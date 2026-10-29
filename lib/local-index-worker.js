/**
 * Cross-platform fallback indexer.
 *
 * Runs in a worker thread and builds an in-memory index by walking the file
 * system. It needs no administrator rights, external index, or native binary,
 * so the plugin works out of the box on Windows, macOS, and Linux. The native
 * Windows MFT service and macOS Spotlight remain the fast paths when available;
 * this worker is the universal floor.
 *
 * Data layout: every lower-cased file name lives in a chain of fixed-size
 * buffers; parallel arrays hold the name offset, length, parent entry, and
 * directory flag. Queries scan the name buffers with `Buffer.indexOf` (native
 * SIMD) and map a hit offset back to an entry by binary search.
 *
 * The worker streams the index while it is being built: queries between
 * directory reads see the entries collected so far instead of waiting for the
 * whole disk.
 *
 * @module dsh-everything-file/local-index-worker
 */

import { parentPort, workerData } from 'node:worker_threads'
import { accessSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

const CHUNK_BYTES = 4 * 1024 * 1024
const PROGRESS_EVERY = 50000
const YIELD_EVERY_DIRS = 512

const options = workerData ?? {}
const maxEntries = Number(options.maxEntries) > 0 ? Number(options.maxEntries) : 12000000
const roots = Array.isArray(options.roots) && options.roots.length > 0 ? options.roots : defaultRoots()
const excludes = (Array.isArray(options.excludes) ? options.excludes : defaultExcludes())
  .map(value => value.toLowerCase().replace(/[\\/]+$/, ''))
  .filter(Boolean)

/** Per-build data. Replaced wholesale on a rebuild. */
function createState() {
  return {
    chunks: [],
    lowerChunks: [],
    bases: [],
    current: Buffer.allocUnsafe(CHUNK_BYTES),
    currentLower: Buffer.allocUnsafe(CHUNK_BYTES),
    cursor: 0,
    base: 0,
    starts: [],
    lengths: [],
    parents: [],
    flags: [],
    count: 0,
    truncated: false,
  }
}

let state = createState()
let building = false
let buildMs = 0
let lastBuildAt = 0

/** Append one entry, finalizing the current buffer when it would overflow. */
function addEntry(target, name, parent, isDirectory) {
  if (target.count >= maxEntries) {
    target.truncated = true
    return -1
  }
  const bytes = Buffer.from(name, 'utf8')
  const lower = asciiLower(bytes)
  if (target.cursor + bytes.length > CHUNK_BYTES) finalizeChunk(target)
  if (bytes.length > CHUNK_BYTES) return -1
  const start = target.base + target.cursor
  target.current.set(bytes, target.cursor)
  target.currentLower.set(lower, target.cursor)
  target.cursor += bytes.length
  const index = target.count++
  target.starts.push(start)
  target.lengths.push(bytes.length)
  target.parents.push(parent)
  target.flags.push(isDirectory ? 1 : 0)
  return index
}

function finalizeChunk(target) {
  if (target.cursor === 0) return
  target.chunks.push(target.current.subarray(0, target.cursor))
  target.lowerChunks.push(target.currentLower.subarray(0, target.cursor))
  target.bases.push(target.base)
  target.base += target.cursor
  target.current = Buffer.allocUnsafe(CHUNK_BYTES)
  target.currentLower = Buffer.allocUnsafe(CHUNK_BYTES)
  target.cursor = 0
}

/** Live view of the finished chunks plus the buffer being filled. */
function viewOf(target) {
  const chunks = target.chunks.slice()
  const lowers = target.lowerChunks.slice()
  const bases = target.bases.slice()
  if (target.cursor > 0) {
    chunks.push(target.current.subarray(0, target.cursor))
    lowers.push(target.currentLower.subarray(0, target.cursor))
    bases.push(target.base)
  }
  return { chunks, lowers, bases }
}

/** Yield to the message queue so queries can run during the build. */
function yieldNow() {
  return new Promise(resolve => setImmediate(resolve))
}

/** Rebuild the whole index from the configured roots. */
async function build() {
  if (building) return
  building = true
  const started = Date.now()
  const next = createState()
  // Publish the empty state immediately so queries between directory reads see
  // the entries collected so far instead of a stale previous build.
  state = next
  const stack = []
  try {
    for (const root of roots) {
      if (isExcluded(root)) continue
      const index = addEntry(next, normaliseRoot(root), -1, true)
      if (index < 0) continue
      stack.push({ dir: root, index })
    }

    let directories = 0
    let lastProgress = 0
    while (stack.length > 0 && next.count < maxEntries) {
      const item = stack.pop()
      let entries
      try {
        entries = await readdir(item.dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const dirent of entries) {
        if (next.count >= maxEntries) {
          next.truncated = true
          break
        }
        if (dirent.isSymbolicLink()) continue
        const isDirectory = dirent.isDirectory()
        if (!isDirectory && !dirent.isFile()) continue
        const full = path.join(item.dir, dirent.name)
        if (isExcluded(full)) continue
        const index = addEntry(next, dirent.name, item.index, isDirectory)
        if (index < 0) continue
        if (isDirectory) {
          stack.push({ dir: full, index })
        }
      }
      directories++
      if ((directories & (YIELD_EVERY_DIRS - 1)) === 0) await yieldNow()
      if (next.count - lastProgress >= PROGRESS_EVERY) {
        lastProgress = next.count
        post({ type: 'progress', entries: next.count, building: true })
        await yieldNow()
      }
    }
    finalizeChunk(next)
    next.bases = next.bases.slice()
    buildMs = Date.now() - started
    lastBuildAt = Date.now()
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  } finally {
    building = false
    post({
      type: 'ready',
      entries: state.count,
      buildMs,
      truncated: state.truncated,
      roots: roots.slice(),
    })
  }
}

/** Map one byte offset back to its entry. */
function entryAt(target, offset) {
  let low = 0
  let high = target.starts.length - 1
  while (low <= high) {
    const middle = low + ((high - low) >> 1)
    if (target.starts[middle] <= offset) low = middle + 1
    else high = middle - 1
  }
  const index = high
  if (index < 0) return -1
  return offset < target.starts[index] + target.lengths[index] ? index : -1
}

function chunkIndexOf(bases, offset) {
  let low = 0
  let high = bases.length - 1
  while (low <= high) {
    const middle = low + ((high - low) >> 1)
    if (bases[middle] <= offset) low = middle + 1
    else high = middle - 1
  }
  return high
}

function nameAt(target, view, index) {
  const offset = target.starts[index]
  const length = target.lengths[index]
  const chunk = chunkIndexOf(view.bases, offset)
  if (chunk < 0) return ''
  return view.chunks[chunk].toString('utf8', offset - view.bases[chunk], offset - view.bases[chunk] + length)
}

/** Resolve the absolute path for one entry. */
function resolvePath(target, view, index, cache) {
  const cached = cache.get(index)
  if (cached !== undefined) return cached
  const segments = []
  let cursor = index
  let guard = 0
  let rootPath = undefined
  while (cursor >= 0 && guard++ < 512) {
    const name = nameAt(target, view, cursor)
    const parent = target.parents[cursor]
    if (parent < 0) {
      rootPath = name
      break
    }
    segments.push(name)
    cursor = parent
  }
  if (rootPath === undefined) return undefined
  segments.reverse()
  const resolved = segments.length === 0 ? rootPath : path.join(rootPath, ...segments)
  cache.set(index, resolved)
  return resolved
}

/** Search the name buffers for one request. */
function query(target, text, max, matchPath, extensions) {
  const rows = []
  const trimmed = String(text ?? '').trim()
  if (trimmed.length === 0) return rows
  const lower = asciiLowerString(trimmed)
  const tokens = lower.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return rows
  const pathQuery = matchPath || /[\\/]/.test(lower)
  const pathNeedle = lower.replaceAll('\\', '/')
  let scanToken
  if (pathQuery) {
    const trimmedPath = lower.replace(/[\\/]+$/, '')
    const separator = Math.max(trimmedPath.lastIndexOf('/'), trimmedPath.lastIndexOf('\\'))
    scanToken = separator >= 0 ? trimmedPath.slice(separator + 1) : trimmedPath
  } else {
    scanToken = tokens.reduce((longest, token) => (token.length > longest.length ? token : longest), '')
  }
  if (scanToken.length === 0) return rows
  const needle = Buffer.from(scanToken, 'utf8')
  const extSuffixes = extensions.map(ext => Buffer.from(`.${ext.replace(/^\./, '').toLowerCase()}`, 'utf8'))
  const view = viewOf(target)
  const cache = new Map()
  const seen = new Set()
  const limit = Math.max(max * 40, 20000)
  let attempts = 0

  for (let chunkIndex = 0; chunkIndex < view.lowers.length && rows.length < max; chunkIndex++) {
    const chunk = view.lowers[chunkIndex]
    const base = view.bases[chunkIndex]
    let position = 0
    while (attempts < limit && rows.length < max) {
      const local = chunk.indexOf(needle, position)
      if (local < 0) break
      position = local + 1
      attempts++
      const index = entryAt(target, base + local)
      if (index < 0 || seen.has(index)) continue
      seen.add(index)
      const nameOffset = target.starts[index] - base
      const nameLength = target.lengths[index]
      if (nameOffset < 0 || nameOffset + nameLength > chunk.length) continue
      if (!pathQuery && !containsAll(chunk, nameOffset, nameLength, tokens)) continue
      const name = chunk.toString('utf8', nameOffset, nameOffset + nameLength)
      if (extSuffixes.length > 0 && !endsWithAny(name, extSuffixes)) continue
      const resolved = resolvePath(target, view, index, cache)
      if (resolved === undefined) continue
      if (pathQuery && !resolved.replaceAll('\\', '/').toLowerCase().includes(pathNeedle)) continue
      rows.push({ path: resolved, folder: target.flags[index] === 1 })
    }
  }
  return rows
}

function containsAll(chunk, offset, length, tokens) {
  for (const token of tokens) {
    const needle = Buffer.from(token, 'utf8')
    if (needle.length > length) return false
    const found = chunk.indexOf(needle, offset)
    if (found < 0 || found > offset + length - needle.length) return false
  }
  return true
}

function endsWithAny(name, suffixes) {
  const lower = name.toLowerCase()
  return suffixes.some(suffix => lower.endsWith(suffix.toString('utf8')))
}

function asciiLower(buffer) {
  const copy = Buffer.from(buffer)
  for (let i = 0; i < copy.length; i++) {
    const byte = copy[i]
    if (byte >= 65 && byte <= 90) copy[i] = byte + 32
  }
  return copy
}

function asciiLowerString(value) {
  let result = ''
  for (const character of value) {
    const code = character.charCodeAt(0)
    result += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : character
  }
  return result
}

function normaliseRoot(root) {
  return path.resolve(root)
}

function normaliseKey(value) {
  return path.resolve(value).toLowerCase()
}

function isExcluded(absolute) {
  const lower = absolute.toLowerCase()
  for (const excluded of excludes) {
    if (lower === excluded || lower.startsWith(excluded + path.sep) || lower.startsWith(excluded + '/')) return true
  }
  return false
}

function defaultRoots() {
  if (process.platform === 'win32') {
    const drives = []
    for (let code = 67; code <= 90; code++) {
      const root = `${String.fromCharCode(code)}:\\`
      try {
        // existsSync would be enough, but readdir proves the drive is readable.
        accessSync(root)
        drives.push(root)
      } catch {
        // Missing or unreadable drive letter.
      }
    }
    return drives
  }
  if (process.platform === 'darwin') return ['/']
  return ['/']
}

function defaultExcludes() {
  if (process.platform === 'darwin') {
    return ['/System/Volumes', '/private/var/db', '/Library/Caches', '/dev']
  }
  if (process.platform === 'win32') {
    return ['C:\\Windows\\WinSxS']
  }
  return ['/proc', '/sys', '/dev', '/run', '/snap', '/var/lib/docker', '/var/lib/containers']
}

function post(message) {
  try {
    parentPort.postMessage(message)
  } catch {
    // The main thread is gone.
  }
}

parentPort.on('message', message => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'query') {
    const rows = query(state, message.text, message.max ?? 100, message.matchPath === true, Array.isArray(message.exts) ? message.exts : [])
    post({ type: 'query', id: message.id, rows })
    return
  }
  if (message.type === 'recent') {
    post({ type: 'recent', id: message.id, rows: [] })
    return
  }
  if (message.type === 'status') {
    post({
      type: 'status',
      id: message.id,
      status: {
        running: true,
        ready: !building && state.count > 0,
        building,
        entries: state.count,
        buildMs,
        lastBuildAt,
        truncated: state.truncated,
        roots: roots.slice(),
      },
    })
    return
  }
  if (message.type === 'rebuild') {
    if (!building) void build()
    post({ type: 'rebuild', id: message.id, ok: true })
    return
  }
  if (message.type === 'dispose') {
    parentPort.close()
  }
})

void build()
