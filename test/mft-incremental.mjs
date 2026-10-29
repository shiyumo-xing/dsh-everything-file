import fs from 'node:fs'
import path from 'node:path'
import { MftIndexEngine } from '../lib/mft-engine.js'

const root = 'D:/Documents/deepseek-harness/default-workspace/.tools/mft-watch-test'
const pipe = 'dsh-mft-test'
const engine = new MftIndexEngine({ pipeName: pipe })

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    const status = await engine.status()
    if (status.running && status.ready) return status
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('index not ready')
}

async function waitQuery(text, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  let last = []
  while (Date.now() < deadline) {
    const result = await engine.query(text, { max: 20 })
    last = result.rows
    if (predicate(last)) return last
    await new Promise(r => setTimeout(r, 150))
  }
  return last
}

const status = await waitReady()
console.log('ready', JSON.stringify(status))

console.log('\nseed query:', (await engine.query('seed', { max: 10 })).rows.map(r => r.path))

const created = path.join(root, 'wow-new.txt')
fs.writeFileSync(created, 'hello')
const createdRows = await waitQuery('wow-new', rows => rows.some(r => r.path.endsWith('wow-new.txt')))
console.log('\nafter create:', createdRows.map(r => r.path))
if (!createdRows.some(r => r.path.endsWith('wow-new.txt'))) throw new Error('create not visible')

const renamed = path.join(root, 'wow-renamed.txt')
fs.renameSync(created, renamed)
const renamedRows = await waitQuery('wow-renamed', rows => rows.some(r => r.path.endsWith('wow-renamed.txt')))
console.log('\nafter rename:', renamedRows.map(r => r.path))
if (!renamedRows.some(r => r.path.endsWith('wow-renamed.txt'))) throw new Error('rename not visible')
const oldRows = await engine.query('wow-new', { max: 10 })
console.log('old name still visible:', oldRows.rows.map(r => r.path))
if (oldRows.rows.some(r => r.path.endsWith('wow-new.txt'))) throw new Error('old name still present')

fs.unlinkSync(renamed)
const deletedRows = await waitQuery('wow-renamed', rows => rows.length === 0)
console.log('\nafter delete:', deletedRows.map(r => r.path))
if (deletedRows.some(r => r.path.endsWith('wow-renamed.txt'))) throw new Error('delete not visible')

const recent = await engine.recent(10)
console.log('\nrecent:', recent.rows.map(r => r.path))
const statusAfter = await engine.status()
console.log('\nstatus after changes', JSON.stringify(statusAfter))

console.log('\nOK incremental overlay works')
engine.dispose()
