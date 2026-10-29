import { EverythingEngine } from '../lib/engine.js'
import { searchCandidates } from '../lib/search.js'
import { performance } from 'node:perf_hooks'

const engine = new EverythingEngine({ logger: { warn: m => console.warn('[warn]', m) } })

async function show(label, query, opts = {}) {
  const started = performance.now()
  const result = await searchCandidates({
    engine,
    cwd: 'D:/Documents/deepseek-harness/default-workspace',
    query,
    limit: opts.limit ?? 12,
    scanLimit: opts.scanLimit ?? 300,
    recentOnEmpty: true,
    timeoutMs: 1500,
  })
  const ms = performance.now() - started
  console.log(`\n== ${label} q=${JSON.stringify(query)} scope=${result.scope} ms=${ms.toFixed(1)} n=${result.candidates.length} err=${result.error?.message ?? 'none'}`)
  for (const c of result.candidates) console.log(`  ${c.kind === 'directory' ? 'D' : 'F'} ${c.path}`)
}

await show('empty', '')
await show('kernel32', 'kernel32', { limit: 10 })
await show('report', 'report', { limit: 10 })
await show('listing', 'dsh-everything-file/li')
await show('absolute listing', 'D:/Documents/deepseek-harness/')
await show('chinese', '报告', { limit: 6 })
await show('pdf', '*.pdf', { limit: 4 })
await show('path query', 'Documents/deepseek-harness', { limit: 6 })

const times = []
for (let i = 0; i < 30; i++) {
  const t0 = performance.now()
  await searchCandidates({ engine, cwd: 'D:/x', query: i % 2 ? 'config' : 'kernel32', limit: 20, scanLimit: 300, timeoutMs: 1500 })
  times.push(performance.now() - t0)
}
times.sort((a, b) => a - b)
console.log('\nwarm picker median', times[15].toFixed(1), 'p90', times[27].toFixed(1), 'max', times[29].toFixed(1))

engine.dispose()
