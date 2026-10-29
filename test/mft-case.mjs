import { MftIndexEngine } from '../lib/mft-engine.js'

const engine = new MftIndexEngine({ pipeName: 'dsh-mft-index' })
await new Promise(resolve => setTimeout(resolve, 2500))
console.log('status', JSON.stringify(await engine.status()))
for (const q of ['NOTICE', 'notice', 'Dsh-Everything-File', 'dsh-everything-file', 'MftIndexer']) {
  const result = await engine.query(q, { max: 5 })
  console.log(`\n[${q}] ${result.rows.length} rows, err=${JSON.stringify(result.error)}`)
  for (const row of result.rows) console.log(' ', row.folder ? 'D' : 'F', row.path)
}
const recent = await engine.recent(3)
console.log('\nrecent', recent.rows.length)
for (const row of recent.rows) console.log(' ', row.path)
engine.dispose()
