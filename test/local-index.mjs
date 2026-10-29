import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LocalIndexEngine } from '../lib/local-index-engine.js'
import { searchCandidates } from '../lib/search.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-local-index-'))
fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
fs.mkdirSync(path.join(root, 'src', 'view'), { recursive: true })
fs.writeFileSync(path.join(root, 'wow-report.txt'), 'x')
fs.writeFileSync(path.join(root, 'docs', 'WOW-notes.md'), 'x')
fs.writeFileSync(path.join(root, 'docs', 'photo.JPG'), 'x')
fs.writeFileSync(path.join(root, 'src', 'view', 'index.js'), 'x')
fs.writeFileSync(path.join(root, 'src', 'wow-util.js'), 'x')
fs.writeFileSync(path.join(root, '中文报告.txt'), 'x')

const engine = new LocalIndexEngine({ roots: [root], excludes: [], maxEntries: 100000, refreshMinutes: 0 })
const started = Date.now()
let status
for (let i = 0; i < 100; i++) {
  status = await engine.status()
  if (status.running && status.ready) break
  await new Promise(resolve => setTimeout(resolve, 100))
}
console.log('status', JSON.stringify(status), 'elapsed', Date.now() - started, 'ms')

async function show(label, text, options = {}) {
  const t0 = performance.now()
  const result = await engine.query(text, options)
  console.log(`[${label}] ${JSON.stringify(text)} ->`, result.rows.map(r => r.path), `${(performance.now() - t0).toFixed(2)} ms`, result.error ?? '')
  return result.rows
}

const wow = await show('name', 'wow', { max: 10 })
if (wow.length !== 3) throw new Error(`expected 3 wow files, got ${wow.length}`)
const caseInsensitive = await show('case', 'WoW', { max: 10 })
if (caseInsensitive.length !== 3) throw new Error('case-insensitive match failed')
const ext = await show('ext', 'wow', { exts: ['md'], max: 10 })
if (ext.length !== 1 || !ext[0].path.endsWith('WOW-notes.md')) throw new Error('ext filter failed')
const pathQuery = await show('path', 'src/view', { matchPath: true, max: 10 })
if (pathQuery.length !== 1 || !pathQuery[0].path.endsWith(path.join('src', 'view'))) throw new Error('path query failed')
const absolute = await show('absolute', path.join(root, 'docs'), { matchPath: true, max: 10 })
if (absolute.length === 0) throw new Error('absolute path query failed')
const unicode = await show('unicode', '中文报告', { max: 10 })
if (unicode.length !== 1) throw new Error('unicode query failed')
const multi = await show('multi', 'wow report', { max: 10 })
if (!multi.some(row => row.path.endsWith('wow-report.txt'))) throw new Error('multi-token query failed')

const viaSearch = await searchCandidates({ engine, cwd: root, query: 'wow', limit: 5, scanLimit: 100 })
console.log('searchCandidates', viaSearch.scope, viaSearch.candidates)
if (viaSearch.candidates.length !== 3 || !viaSearch.candidates.every(c => c.kind === 'file')) throw new Error('searchCandidates local contract failed')
console.log('recent', (await engine.recent(5)).rows.length)
await engine.rebuild()
await new Promise(resolve => setTimeout(resolve, 500))
const afterRebuild = await show('after rebuild', 'index.js', { max: 10 })
if (afterRebuild.length === 0) throw new Error('query after rebuild failed')

engine.dispose()
fs.rmSync(root, { recursive: true, force: true })
console.log('\nOK local index backend')
