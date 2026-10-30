/**
 * Manual macOS smoke test for the Spotlight backend.
 *
 * Not part of `npm test`: it needs a real Mac with Spotlight indexing enabled,
 * and it prints what the picker would show rather than asserting fixtures.
 *
 *   node test/manual-macos.mjs [query ...]
 *
 * With no arguments it runs a representative set (Chinese name, extension
 * filter, empty page) plus a Keystroke burst that used to stall `mds`.
 */

import { performance } from 'node:perf_hooks'
import { SpotlightEngine } from '../lib/spotlight-engine.js'
import { searchCandidates } from '../lib/search.js'

const engine = new SpotlightEngine({ logger: { warn: message => console.warn('[warn]', message) } })
const cwd = process.cwd()

/** Show one lookup the way the `@` picker would. */
async function show(label, query, options = {}) {
  const started = performance.now()
  const result = await searchCandidates({
    engine,
    cwd,
    query,
    limit: options.limit ?? 8,
    scanLimit: options.scanLimit ?? 300,
    recentOnEmpty: true,
    timeoutMs: 5000,
  })
  const ms = performance.now() - started
  console.log(`\n== ${label} q=${JSON.stringify(query)} scope=${result.scope} ms=${ms.toFixed(0)} n=${result.candidates.length} err=${result.error?.message ?? 'none'}`)
  for (const candidate of result.candidates) console.log(`  ${candidate.kind === 'directory' ? 'D' : 'F'} ${candidate.path}`)
}

/**
 * Replay typing as the editor does it: one request per character, each
 * superseding the previous one.
 */
async function burst(label, sequence) {
  console.log(`\n== burst ${label} (${sequence.join(' → ')})`)
  // A fresh engine per burst: the earlier lookups cached their own queries, and a
  // cached answer would hide the very latency this harness measures.
  const burstEngine = new SpotlightEngine()
  const started = performance.now()
  const controllers = []
  const timings = []
  // The editor does not wait for a keystroke's answer before sending the next
  // one: every request goes out, and the previous one is aborted.
  const requests = sequence.map((query, index) => new Promise(resolve => setTimeout(async () => {
    for (const controller of controllers) controller.abort()
    const controller = new AbortController()
    controllers.push(controller)
    const at = performance.now()
    const result = await searchCandidates({
      engine: burstEngine,
      cwd,
      query,
      limit: 8,
      scanLimit: 300,
      recentOnEmpty: true,
      timeoutMs: 5000,
      signal: controller.signal,
    })
    timings[index] = { query, ms: performance.now() - at, rows: result.candidates.length, error: result.error?.message, candidates: result.candidates }
    resolve()
  }, index * 80)))
  await Promise.all(requests)
  const last = timings.at(-1)
  console.log(`  final ${JSON.stringify(last.query)} answered in ${last.ms.toFixed(0)} ms with ${last.rows} row(s)`)
  for (const candidate of last.candidates) console.log(`    ${candidate.kind === 'directory' ? 'D' : 'F'} ${candidate.path}`)
  const errors = timings.filter(entry => entry.error !== undefined)
  console.log(`  wall ${(performance.now() - started).toFixed(0)} ms for ${sequence.length} keystrokes, errors ${errors.length}`)
  if (errors.length > 0) for (const entry of errors) console.log(`  ERR ${JSON.stringify(entry.query)}: ${entry.error}`)
  burstEngine.dispose()
}

/**
 * The pattern that surfaced the 0.4.1 regression: the picker re-asks for one
 * text as its caret and spans settle, aborting the previous generation first.
 * Every repeat has to share one scan; otherwise no scan ever finishes.
 */
async function repeat(label, query, times = 6) {
  console.log(`\n== repeat ${label} (${JSON.stringify(query)} x${times})`)
  const repeatEngine = new SpotlightEngine()
  const started = performance.now()
  let previous
  const requests = []
  for (let index = 0; index < times; index++) {
    requests.push(new Promise(done => setTimeout(async () => {
      previous?.abort()
      const controller = new AbortController()
      previous = controller
      const at = performance.now()
      const result = await searchCandidates({
        engine: repeatEngine,
        cwd,
        query,
        limit: 8,
        scanLimit: 300,
        recentOnEmpty: true,
        timeoutMs: 5000,
        signal: controller.signal,
      })
      if (index === times - 1) {
        console.log(`  final answered in ${(performance.now() - at).toFixed(0)} ms with ${result.candidates.length} row(s)`)
        for (const candidate of result.candidates) console.log(`    ${candidate.kind === 'directory' ? 'D' : 'F'} ${candidate.path}`)
      }
      done()
    }, index * 40)))
  }
  await Promise.all(requests)
  console.log(`  wall ${(performance.now() - started).toFixed(0)} ms for ${times} repeats`)
  repeatEngine.dispose()
}

try {
  const queries = process.argv.slice(2)
  if (queries.length > 0) {
    for (const query of queries) await show(query, query)
  } else {
    await show('empty @', '')
    await show('chinese name', '测试')
    await show('single chinese char', '测')
    await show('extension filter', '*.md')
    await show('latin word', 'report')
    await burst('latin word', ['r', 're', 'rep', 'repo', 'repor', 'report'])
    await burst('IME pinyin then commit', ['c', 'ce', 'ces', 'cesh', 'ceshi', '测试'])
    await repeat('same text re-asked', '测试')
  }
} finally {
  engine.dispose()
}
