import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SpotlightEngine } from '../lib/spotlight-engine.js'

const posix = value => value.replaceAll('\\', '/')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spotlight-'))
const folder = path.join(root, 'my-folder')
const file = path.join(folder, 'wow-file.txt')
const json = path.join(root, 'package.json')
fs.mkdirSync(folder)
fs.writeFileSync(file, 'x')
fs.writeFileSync(json, '{}')

const listed = [posix(folder), posix(file), posix(json), posix(path.join(root, 'deleted.txt'))]
let calls = []
const engine = new SpotlightEngine({
  run: async args => {
    calls.push(args)
    return { stdout: listed.join('\n') }
  },
})

try {
  const byName = await engine.query('wow', { max: 5 })
  console.log('query args:', JSON.stringify(calls.at(-1)))
  if (byName.rows.length !== 1 || byName.rows[0].path !== posix(file) || byName.rows[0].folder !== false) {
    throw new Error(`name query failed: ${JSON.stringify(byName.rows)}`)
  }

  const byFolder = await engine.query('my-folder', { max: 5 })
  if (byFolder.rows.length !== 1 || byFolder.rows[0].folder !== true) throw new Error('directory row missing')

  const extFiltered = await engine.query('package', { exts: ['json'], max: 5 })
  console.log('ext args:', JSON.stringify(calls.at(-1)))
  if (extFiltered.rows.length !== 1 || extFiltered.rows[0].path !== posix(json)) throw new Error('ext filter failed')

  const pathQuery = await engine.query(posix(folder), { matchPath: true, max: 5 })
  console.log('path rows:', pathQuery.rows)
  if (pathQuery.rows.length !== 2) throw new Error('path query failed')

  if (pathQuery.rows.some(row => row.path.includes('deleted'))) throw new Error('stale path not filtered')

  const before = calls.length
  await engine.query('wow', { max: 5 })
  if (calls.length !== before) throw new Error('cache not used')

  // A single ASCII letter must become a prefix query: the substring spelling
  // scans most of the index and blows the query deadline on a real Mac.
  await engine.query('a', { max: 5 })
  if (calls.at(-1)[0] !== 'kMDItemFSName == "a*"cd') throw new Error(`single letter not a prefix query: ${calls.at(-1)[0]}`)
  await engine.query('ab', { max: 5 })
  if (calls.at(-1)[0] !== 'kMDItemFSName == "*ab*"cd') throw new Error(`two letters should stay a substring query: ${calls.at(-1)[0]}`)

  // macOS indexes decomposed names, so an accented term needs both spellings.
  await engine.query('caf\u00e9', { max: 5 })
  const accented = calls.at(-1)[0]
  if (!accented.includes('||') || !accented.includes('cafe\u0301')) throw new Error(`accented term not normalized: ${accented}`)

  const failing = new SpotlightEngine({ run: async () => { throw new Error('spotlight disabled') } })
  const failure = await failing.query('x')
  if (!failure.error || failure.error.code !== 2) throw new Error('error not reported')
  failing.dispose()

  // One keystroke per request: only the newest query may reach mdfind, and a
  // superseded scan must not hold the slot.
  let runs = 0
  const slow = new SpotlightEngine({
    run: async () => {
      runs += 1
      await new Promise(resolve => setTimeout(resolve, 60))
      return { stdout: posix(file) }
    },
  })
  const burst = [
    slow.query('a', { max: 5 }),
    slow.query('ab', { max: 5 }),
    slow.query('wow', { max: 5 }),
  ]
  const settled = await Promise.all(burst)
  if (runs > 2) throw new Error(`keystrokes were not coalesced: ${runs} mdfind runs`)
  if (settled[0].rows.length !== 0 || settled[1].rows.length !== 0) throw new Error('superseded lookups should return no rows')
  if (settled[2].rows.length !== 1) throw new Error(`the newest lookup lost its rows: ${JSON.stringify(settled[2])}`)
  slow.dispose()

  // Empty answers are never cached: a file that appears a moment later (or a
  // directory the user just created) must be found by the next keystroke.
  let stdout = ''
  let emptyRuns = 0
  const appearing = new SpotlightEngine({
    run: async () => {
      emptyRuns += 1
      return { stdout }
    },
  })
  const firstLookup = await appearing.query('wow', { max: 5 })
  if (firstLookup.rows.length !== 0) throw new Error('unexpected rows before the file was indexed')
  if (emptyRuns !== 1) throw new Error('the first lookup did not scan')
  stdout = posix(file)
  const secondLookup = await appearing.query('wow', { max: 5 })
  if (secondLookup.rows.length !== 1) throw new Error('an empty answer was cached across a new file')
  if (emptyRuns !== 2) throw new Error('the empty answer was served from the cache')
  appearing.dispose()

  // The picker re-asks for one text as its caret and spans settle. Those
  // repeats must share the scan instead of superseding each other, otherwise no
  // scan ever finishes and only cached answers appear.
  let joinedRuns = 0
  const joining = new SpotlightEngine({
    run: async () => {
      joinedRuns += 1
      await new Promise(resolve => setTimeout(resolve, 60))
      return { stdout: posix(file) }
    },
  })
  const first = new AbortController()
  const second = new AbortController()
  const repeated = [joining.query('wow', { max: 5, signal: first.signal })]
  await new Promise(resolve => setTimeout(resolve, 10))
  repeated.push(joining.query('wow', { max: 5, signal: second.signal }))
  await new Promise(resolve => setTimeout(resolve, 10))
  // The first generation's controller is aborted by the second fetch, exactly as
  // `fetchCandidates` does; the joined scan must survive for the newer caller.
  first.abort()
  const joined = await Promise.all(repeated)
  if (joinedRuns !== 1) throw new Error(`repeated query scanned ${joinedRuns} times instead of joining`)
  if (joined[1].rows.length !== 1) throw new Error(`joined lookup lost its rows: ${JSON.stringify(joined[1])}`)
  joining.dispose()

  // A caller abort must not cancel the scan: "every caller aborted" is the state
  // of a scan that is about to be joined by the next generation.
  let abortRuns = 0
  const abortable = new SpotlightEngine({
    run: async () => {
      abortRuns += 1
      await new Promise(resolve => setTimeout(resolve, 40))
      return { stdout: posix(file) }
    },
  })
  const controller = new AbortController()
  const pending = abortable.query('wow', { max: 5, signal: controller.signal })
  setTimeout(() => controller.abort(), 10)
  const aborted = await pending
  if (aborted.error !== undefined) throw new Error('an aborted caller must not surface an error')
  if (aborted.rows.length !== 1) throw new Error(`an aborted caller still gets the finished scan: ${JSON.stringify(aborted)}`)
  if (abortRuns !== 1) throw new Error('aborting a caller restarted the scan')
  const after = await abortable.query('wow-file', { max: 5 })
  if (after.rows.length !== 1) throw new Error('the engine stopped answering after an aborted caller')
  abortable.dispose()

  // The empty-`@` page: recently changed paths ordered by modification time,
  // stale rows dropped, directories flagged.
  const older = path.join(root, 'older.txt')
  const newer = path.join(root, 'newer.txt')
  fs.writeFileSync(older, 'x')
  const past = new Date(Date.now() - 3600_000)
  fs.utimesSync(older, past, past)
  fs.writeFileSync(newer, 'x')
  const recentEngine = new SpotlightEngine({
    run: async () => ({ stdout: [older, newer, folder, path.join(root, 'gone.txt')].map(posix).join('\n') }),
  })
  const recent = await recentEngine.recent(10)
  if (recent.error !== undefined) throw new Error(`recent failed: ${recent.error.message}`)
  const names = recent.rows.map(row => row.path)
  if (names[0] !== posix(newer)) throw new Error(`recent is not newest-first: ${JSON.stringify(names)}`)
  if (!names.includes(posix(folder)) || !names.includes(posix(older))) throw new Error('recent dropped existing rows')
  if (names.some(name => name.endsWith('gone.txt'))) throw new Error('recent kept a stale row')
  if (recent.rows.find(row => row.path === posix(folder))?.folder !== true) throw new Error('recent lost the folder flag')
  await recentEngine.recent(10)
  recentEngine.dispose()

  console.log('OK spotlight engine')
} finally {
  engine.dispose()
  fs.rmSync(root, { recursive: true, force: true })
}
