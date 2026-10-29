/**
 * Candidate discovery for the Everything-backed `@file` provider.
 *
 * Three discovery modes, mirroring how people type after `@`:
 *  - empty query: recently modified files across every indexed disk (a
 *    "quick open" list), with obvious machine-noise directories filtered out;
 *  - a query containing `/` or `\`: a live directory listing (the same
 *    drill-down behavior the shipped provider has, but rooted at any host
 *    folder once the typed prefix is absolute);
 *  - anything else: a global Everything filename search, locally re-ranked so
 *    exact and prefix name matches beat incidental path matches.
 *
 * Everything answers with an in-memory NTFS index, so the expensive part is the
 * IPC round trip, not the match; the scan limit bounds how many rows cross the
 * bridge before local ranking picks the visible page.
 *
 * @module dsh-everything-file/search
 */

import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Everything SDK sort codes used here. */
export const SORT_NAME_ASCENDING = 1
export const SORT_DATE_MODIFIED_DESCENDING = 14

/**
 * Machine-noise path fragments: they stay searchable, but rank below real
 * matches and never fill the empty-query "recent files" page.
 */
const NOISE_FRAGMENTS = [
  '/node_modules/',
  '/appdata/local/temp/',
  '/appdata/locallow/',
  '/appdata/local/packages/',
  '/windows/winsxs/',
  '/$recycle.bin/',
  '/.git/',
  '/.dsh/sessions/',
  '/.cache/',
]

/**
 * Additional fragments hidden from the empty-query page: system and cache churn
 * that is never the file a person is looking for when they just typed `@`.
 */
const RECENT_NOISE_FRAGMENTS = [
  ...NOISE_FRAGMENTS,
  '/windows/',
  '/appdata/',
  '/programdata/',
  '/program files/',
  '/program files (x86)/',
  '/.dsh/',
  '/target/',
  '/build/',
  '/dist/',
  '/.idea/',
  '/.vscode/',
  '/system volume information/',
]

/** Everything search functions recognized when a token is passed through raw. */
const EVERYTHING_FUNCTION = /^(ext|path|parent|file|folder|dm|dc|da|size|attrib|regex|wfn|nopath|case|nocase|wholefilename|nowholefilename|dupe|empty|len|count|startwith|endwith|type):/i

/**
 * @typedef {object} FileCandidate
 * @property {string} path - display path (forward slashes), relative only when the caller passed one.
 * @property {'file' | 'directory'} kind
 */

/**
 * Search file-reference candidates.
 * @param {object} options
 * @param {import('./engine.js').EverythingEngine} options.engine
 * @param {string | undefined} options.cwd - the session workspace used to resolve relative path queries.
 * @param {string} options.query - raw text after `@`.
 * @param {number} options.limit - visible candidates.
 * @param {number} options.scanLimit - rows to fetch from Everything before local ranking.
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.recentOnEmpty] - answer an empty query with recent files.
 * @returns {Promise<{ candidates: FileCandidate[], error?: { code: number, message: string }, scope: 'recent' | 'directory' | 'global' }>}
 */
export async function searchCandidates(options) {
  const query = typeof options.query === 'string' ? options.query.trim() : ''
  if (query === '') {
    if (options.recentOnEmpty === false) return { candidates: [], scope: 'recent' }
    return recentCandidates(options)
  }

  const normalized = query.replaceAll('\\', '/')
  if (normalized.includes('/')) {
    const listed = await listDirectory(normalized, options)
    if (listed !== undefined) return { candidates: listed, scope: 'directory' }
  }
  return globalCandidates(query, options)
}

/**
 * Recently modified files across the index, minus machine noise.
 * @param {object} options - same shape as {@link searchCandidates}.
 */
async function recentCandidates(options) {
  const fetchLimit = Math.min(2000, Math.max(240, options.limit * 12))
  const localContract = options.engine.kind === 'mft' || options.engine.kind === 'spotlight' || options.engine.kind === 'local'
  const result = localContract
    ? await options.engine.recent(fetchLimit, { timeoutMs: options.timeoutMs })
    : await options.engine.query('*', {
      max: fetchLimit,
      sort: SORT_DATE_MODIFIED_DESCENDING,
      matchPath: false,
      signal: options.signal,
      indexWaitMs: options.indexWaitMs ?? 0,
      timeoutMs: options.timeoutMs,
    })
  if (result.error !== undefined) return { candidates: [], error: result.error, scope: 'recent' }
  const candidates = []
  for (const row of result.rows) {
    const display = toDisplayPath(row.path)
    if (isRecentNoise(display.toLowerCase())) continue
    candidates.push({ path: display, kind: row.folder ? 'directory' : 'file' })
    if (candidates.length >= options.limit) break
  }
  return { candidates, scope: 'recent' }
}

/**
 * List one host directory for a path-shaped query.
 * @param {string} normalized - the query with forward slashes.
 * @param {object} options - same shape as {@link searchCandidates}.
 * @returns {Promise<FileCandidate[] | undefined>} undefined when the prefix is not an existing directory.
 */
async function listDirectory(normalized, options) {
  const slash = normalized.lastIndexOf('/')
  const directoryText = slash < 0 ? '' : normalized.slice(0, slash)
  const fragment = slash < 0 ? '' : normalized.slice(slash + 1)
  const base = resolveDirectoryBase(directoryText, options.cwd)
  if (base === undefined) return undefined

  let entries
  try {
    options.signal?.throwIfAborted()
    entries = await readdir(base, { withFileTypes: true })
    options.signal?.throwIfAborted()
  } catch {
    return undefined
  }

  const candidates = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const directory = entry.isDirectory()
    if (!directory && !entry.isFile()) continue
    candidates.push({
      path: joinDisplay(base, entry.name),
      kind: directory ? 'directory' : 'file',
      name: entry.name,
    })
  }

  if (fragment === '') {
    return candidates
      .sort((left, right) => {
        const leftDirectory = left.kind === 'directory' ? 0 : 1
        const rightDirectory = right.kind === 'directory' ? 0 : 1
        if (leftDirectory !== rightDirectory) return leftDirectory - rightDirectory
        return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
      })
      .slice(0, options.limit)
      .map(({ name: _name, ...candidate }) => candidate)
  }
  return rankListing(candidates, fragment, options.limit)
    .map(({ name: _name, ...candidate }) => candidate)
}

/**
 * Rank a live directory listing by the typed fragment of the entry name only.
 * A drill-down is a name completion, so the parent path must not create weak
 * subsequence matches for every sibling in the folder.
 * @param {Array<{ path: string, kind: 'file' | 'directory', name: string }>} candidates
 * @param {string} fragment
 * @param {number} limit
 * @returns {FileCandidate[]}
 */
function rankListing(candidates, fragment, limit) {
  const needle = fragment.toLowerCase()
  const scored = []
  for (const candidate of candidates) {
    const name = candidate.name.toLowerCase()
    let score
    if (name === needle) score = 1000
    else if (name.startsWith(needle)) score = 900
    else if (name.includes(needle)) score = 700
    else {
      const subsequence = subsequenceScore(name, needle)
      if (subsequence === undefined) continue
      score = 300 + subsequence
    }
    if (candidate.kind === 'directory') score += 25
    scored.push({ candidate, score })
  }
  scored.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score
    const leftDirectory = left.candidate.kind === 'directory' ? 0 : 1
    const rightDirectory = right.candidate.kind === 'directory' ? 0 : 1
    if (leftDirectory !== rightDirectory) return leftDirectory - rightDirectory
    return left.candidate.name.localeCompare(right.candidate.name, undefined, { numeric: true, sensitivity: 'base' })
  })
  return scored.slice(0, limit).map(entry => entry.candidate)
}

/**
 * Resolve the typed directory prefix to an absolute host path.
 * @param {string} directoryText
 * @param {string | undefined} cwd
 * @returns {string | undefined}
 */
function resolveDirectoryBase(directoryText, cwd) {
  if (directoryText === '') {
    if (cwd === undefined) return undefined
    return cwd
  }
  if (/^[a-zA-Z]:$/.test(directoryText)) return `${directoryText}/`
  if (/^[a-zA-Z]:\//.test(directoryText)) return directoryText
  if (directoryText.startsWith('//')) return directoryText
  if (cwd === undefined) return undefined
  return resolve(cwd, directoryText)
}

/**
 * Global filename search with local relevance ranking. The local NTFS index and
 * the optional Everything backend take the same candidate shape; only the query
 * spelling differs.
 * @param {string} query - the raw query.
 * @param {object} options - same shape as {@link searchCandidates}.
 */
async function globalCandidates(query, options) {
  const local = options.engine.kind === 'mft' || options.engine.kind === 'spotlight' || options.engine.kind === 'local'
  let rows
  if (local) {
    const parsed = parseIndexQuery(query)
    if (parsed.text === '' && parsed.exts.length === 0) return { candidates: [], scope: 'global' }
    const result = await options.engine.query(parsed.text, {
      max: options.scanLimit,
      matchPath: parsed.matchPath,
      exts: parsed.exts,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
    if (result.error !== undefined) return { candidates: [], error: result.error, scope: 'global' }
    rows = result.rows
  } else {
    const built = buildEverythingSearch(query)
    const result = await options.engine.query(built.search, {
      max: options.scanLimit,
      sort: SORT_NAME_ASCENDING,
      matchPath: built.matchPath,
      signal: options.signal,
      indexWaitMs: options.indexWaitMs ?? 0,
      timeoutMs: options.timeoutMs,
    })
    if (result.error !== undefined) return { candidates: [], error: result.error, scope: 'global' }
    rows = result.rows

    // Everything returns its name-sorted head, which for a broad term can stop
    // before the best name match (many `kernel32*` files sort before
    // `kernel32.dll`). One extra whole-filename prefix query pins those rows into
    // the candidate set before local ranking.
    const prefix = prefixSearch(query)
    if (prefix !== undefined) {
      const extra = await options.engine.query(prefix, {
        max: 60,
        sort: SORT_NAME_ASCENDING,
        matchPath: false,
        signal: options.signal,
        indexWaitMs: options.indexWaitMs ?? 0,
        timeoutMs: options.timeoutMs,
      })
      if (extra.error === undefined) rows = mergeRows(rows, extra.rows)
    }
  }

  return {
    candidates: rankCandidates(rows.map(row => ({
      path: toDisplayPath(row.path),
      kind: row.folder ? 'directory' : 'file',
    })), query, options.limit),
    scope: 'global',
  }
}

/**
 * Translate picker text into the local index's query contract: whitespace
 * separated terms are ANDed over the file name, `ext:pdf` and `*.pdf` become
 * extension filters, `wfn:` prefixes are dropped, and a term containing a
 * separator switches the match to the resolved full path.
 * @param {string} query
 * @returns {{ text: string, exts: string[], matchPath: boolean }}
 */
export function parseIndexQuery(query) {
  const tokens = String(query ?? '').trim().split(/\s+/).filter(Boolean)
  const exts = []
  const plain = []
  let matchPath = false
  for (const token of tokens) {
    const extFunction = /^ext:([\p{L}\p{N}_.-]+)$/iu.exec(token)
    if (extFunction !== null) {
      exts.push(extFunction[1])
      continue
    }
    const wildcardExt = /^\*\.([\p{L}\p{N}_-]+)$/u.exec(token)
    if (wildcardExt !== null) {
      exts.push(wildcardExt[1])
      continue
    }
    let value = token
    if (/^wfn:/i.test(value)) value = value.slice(4)
    value = value.replace(/[*?]/g, '')
    if (value.length === 0) continue
    if (/[\\/]/.test(value)) matchPath = true
    plain.push(value)
  }
  let text = plain.join(' ')
  if (text === '' && exts.length > 0) text = exts.map(ext => `.${ext}`).join(' ')
  return { text, exts, matchPath }
}

/**
 * A whole-filename prefix query for a plain single-word term, or undefined when
 * the term contains operators, whitespace, or path syntax.
 * @param {string} query
 * @returns {string | undefined}
 */
function prefixSearch(query) {
  const trimmed = query.trim()
  if (!/^[\p{L}\p{N}_.-]{2,}$/u.test(trimmed)) return undefined
  return `wfn:${trimmed}*`
}

/**
 * Merge a secondary result set into the primary one, keeping first-seen paths.
 * @param {import('./engine.js').EngineRow[]} primary
 * @param {import('./engine.js').EngineRow[]} extra
 * @returns {import('./engine.js').EngineRow[]}
 */
function mergeRows(primary, extra) {
  const seen = new Set(primary.map(row => row.path.toLowerCase()))
  const merged = [...primary]
  for (const row of extra) {
    const key = row.path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(row)
  }
  return merged
}

/**
 * Translate the picker's raw token into an Everything search string.
 *
 * Everything ANDs whitespace-separated terms and matches file names by default;
 * a term containing a path separator switches the whole query to full-path
 * matching. Ordinary terms are quoted so a stray Everything operator in a file
 * name cannot change the meaning of the query, while wildcard and documented
 * Everything functions (`ext:pdf`, `dm:today`, ...) pass through.
 *
 * @param {string} query
 * @returns {{ search: string, matchPath: boolean }}
 */
export function buildEverythingSearch(query) {
  const trimmed = query.trim()
  if (trimmed === '') return { search: '*', matchPath: false }
  const rawTokens = trimmed.split(/\s+/)
  const pathLike = rawTokens.some(token => token.includes('/') || token.includes('\\'))
  // Everything matches path text with native separators; the picker accepts the
  // forward-slash spellings people type (and the spellings it displays).
  const tokens = pathLike ? rawTokens.map(token => token.replaceAll('/', '\\')) : rawTokens
  const search = tokens
    .map(token => {
      if (EVERYTHING_FUNCTION.test(token) || /[*?"|!]/.test(token)) return token
      return `"${token.replaceAll('"', '')}"`
    })
    .join(' ')
  return { search, matchPath: pathLike }
}

/**
 * Rank candidates for the visible page.
 * @param {Array<{ path: string, kind: 'file' | 'directory' }>} candidates
 * @param {string} query
 * @param {number} limit
 * @returns {FileCandidate[]}
 */
export function rankCandidates(candidates, query, limit) {
  const term = rankTerm(query)
  if (term === '') return candidates.slice(0, limit)
  const needle = term.toLowerCase()
  const scored = []
  for (const candidate of candidates) {
    const lower = candidate.path.toLowerCase()
    const score = scorePath(lower, needle, candidate.kind === 'directory')
    scored.push({ candidate, score: score ?? -1000, lower })
  }
  scored.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score
    const leftDirectory = left.candidate.kind === 'directory' ? 0 : 1
    const rightDirectory = right.candidate.kind === 'directory' ? 0 : 1
    if (leftDirectory !== rightDirectory) return leftDirectory - rightDirectory
    if (left.candidate.path.length !== right.candidate.path.length) {
      return left.candidate.path.length - right.candidate.path.length
    }
    return left.candidate.path.localeCompare(right.candidate.path)
  })
  return scored.slice(0, limit).map(entry => entry.candidate)
}

/**
 * The term used for ranking: the last whitespace-separated token, stripped of
 * an Everything function prefix. Everything has already filtered the rows, so a
 * row that term does not describe still survives (scored last) rather than
 * disappearing from a query it matched.
 * @param {string} query
 */
function rankTerm(query) {
  const tokens = query.trim().split(/\s+/).filter(Boolean)
  const last = tokens.at(-1) ?? ''
  return last.replace(EVERYTHING_FUNCTION, '')
}

/**
 * Relevance score for one absolute path, or undefined when nothing matches.
 * @param {string} pathLower - lower-cased display path.
 * @param {string} needle - lower-cased ranking term.
 * @param {boolean} directory
 * @returns {number | undefined}
 */
function scorePath(pathLower, needle, directory) {
  const name = pathLower.slice(pathLower.lastIndexOf('/') + 1)
  let score
  if (name === needle) score = 1000
  else if (name.startsWith(needle)) score = 900
  else if (name.includes(needle)) score = 700
  else if (pathLower.includes(needle)) score = 500
  else {
    const subsequence = subsequenceScore(pathLower, needle)
    if (subsequence === undefined) return undefined
    score = 300 + subsequence
  }
  if (directory) score += 25
  score -= Math.min(depthOf(pathLower), 12)
  if (isNoise(pathLower)) score -= 45
  return score
}

/**
 * Gap-penalized subsequence score for the last-resort fuzzy tier.
 * @param {string} target
 * @param {string} query
 * @returns {number | undefined}
 */
function subsequenceScore(target, query) {
  let targetIndex = 0
  let gap = 0
  for (const character of query) {
    const found = target.indexOf(character, targetIndex)
    if (found < 0) return undefined
    gap += found - targetIndex
    targetIndex = found + 1
  }
  return Math.max(0, 100 - gap)
}

/** Number of path separators, used as a shallow-match bonus. */
function depthOf(pathLower) {
  let depth = 0
  for (const character of pathLower) if (character === '/') depth += 1
  return depth
}

/** True when the path sits inside a machine-generated directory. */
function isNoise(pathLower) {
  return NOISE_FRAGMENTS.some(fragment => pathLower.includes(fragment))
}

/** True when a recently changed path is system/cache churn, not a user file. */
function isRecentNoise(pathLower) {
  return RECENT_NOISE_FRAGMENTS.some(fragment => pathLower.includes(fragment))
}

/** Convert a native Windows path to the display form the reference grammar takes. */
export function toDisplayPath(path) {
  return path.replaceAll('\\', '/')
}

/** Join a directory and an entry name using forward slashes. */
function joinDisplay(base, name) {
  const normalized = toDisplayPath(base).replace(/\/+$/, '')
  return normalized === '' ? name : `${normalized}/${name}`
}
