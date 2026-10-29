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

  const failing = new SpotlightEngine({ run: async () => { throw new Error('spotlight disabled') } })
  const failure = await failing.query('x')
  if (!failure.error || failure.error.code !== 2) throw new Error('error not reported')
  failing.dispose()

  console.log('OK spotlight engine')
} finally {
  engine.dispose()
  fs.rmSync(root, { recursive: true, force: true })
}
