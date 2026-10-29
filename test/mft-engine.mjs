import { MftIndexEngine } from '../lib/mft-engine.js'
import { searchCandidates, parseIndexQuery } from '../lib/search.js'

const engine = new MftIndexEngine({ pipeName: 'dsh-mft-index' })
console.log('status', JSON.stringify(await engine.status()))
console.log('parse', JSON.stringify(parseIndexQuery('dsh-everything-file')))
const direct = await engine.query('dsh-everything-file', { max: 20 })
console.log('direct rows', direct.rows.length, 'error', direct.error)
for (const row of direct.rows.slice(0, 5)) console.log(' ', row.folder ? 'D' : 'F', row.path)
const recent = await engine.recent(5)
console.log('recent rows', recent.rows.length, 'error', recent.error)
const search = await searchCandidates({
  engine,
  cwd: 'D:/Documents/deepseek-harness/default-workspace',
  query: 'dsh-everything-file',
  limit: 5,
  scanLimit: 300,
})
console.log('search', search.scope, search.candidates.length, search.error)
for (const c of search.candidates) console.log(' ', c.kind, c.path)
engine.dispose()
