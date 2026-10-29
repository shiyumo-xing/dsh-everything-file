import net from 'node:net'
import { performance } from 'node:perf_hooks'

const pipe = '\\\\.\\pipe\\dsh-mft-test'
const socket = net.connect(pipe)
socket.setEncoding('utf8')

let buffer = ''
const pending = new Map()
let current = null
let nextId = 1

socket.on('data', chunk => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    onLine(line)
  }
})

function onLine(line) {
  const parts = line.split('\t')
  const head = pending.get(parts[0])
  if (head !== undefined) {
    if (parts[1] === 'OK') {
      if (Number(parts[2]) === 0) {
        pending.delete(parts[0])
        current = null
        head.resolve({ rows: [], ms: performance.now() - head.started })
      } else {
        head.rows = []
        current = head
      }
      return
    }
    if (parts[1] === 'END') {
      pending.delete(parts[0])
      current = null
      head.resolve({ rows: head.rows, ms: performance.now() - head.started })
      return
    }
    if (parts[1] === 'ERR') {
      pending.delete(parts[0])
      current = null
      head.resolve({ error: { code: Number(parts[2]), message: parts[3] }, rows: [], ms: performance.now() - head.started })
      return
    }
    if (parts[1] === 'STATUS') {
      pending.delete(parts[0])
      current = null
      head.resolve({ status: { ready: parts[2] === '1', entries: Number(parts[3]), building: parts[4] === '1', buildMs: Number(parts[5]), source: parts[6] }, ms: performance.now() - head.started })
      return
    }
  }
  if (current !== null && (parts[0] === 'F' || parts[0] === 'D')) {
    current.rows.push({ directory: parts[0] === 'D', path: parts.slice(1).join('\t') })
  }
}

function request(command, payload = '') {
  const id = String(nextId++)
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, rows: [], started: performance.now() }
    pending.set(id, entry)
    socket.write(`${id}\t${command}${payload}\n`)
  })
}

function query(text, max = 20, matchPath = false, exts = '') {
  const payload = `\t${max}\t${matchPath ? 1 : 0}\t${Buffer.from(text).toString('base64')}\t${Buffer.from(exts).toString('base64')}`
  return request('QUERY', payload)
}

function recent(max = 20) {
  return request('RECENT', `\t${max}`)
}

await new Promise((resolve, reject) => {
  socket.once('connect', resolve)
  socket.once('error', reject)
})

console.log('status', JSON.stringify((await request('STATUS')).status))

for (const [label, text, opts] of [
  ['wow', 'wow', {}],
  ['indexer', 'indexer', {}],
  ['dsh', 'dsh', {}],
  ['dsh/plugin', 'dsh-everything-file', {}],
  ['path', 'dsh-everything-file\\lib', { matchPath: true }],
  ['ext', 'package', { exts: 'json' }],
  ['multi', 'everything file', {}],
]) {
  const result = await query(text, 20, opts.matchPath ?? false, opts.exts ?? '')
  console.log(`\n[${label}] ${text} -> ${result.rows.length} rows, ${result.ms.toFixed(1)} ms`)
  for (const row of result.rows.slice(0, 5)) console.log(' ', row.directory ? 'D' : 'F', row.path)
}

const r = await recent(10)
console.log(`\n[recent] ${r.rows.length} rows`)
for (const row of r.rows.slice(0, 5)) console.log(' ', row.path)

const times = []
for (let i = 0; i < 20; i++) {
  const result = await query(i % 2 ? 'indexer' : 'dsh', 50)
  times.push(result.ms)
}
times.sort((a, b) => a - b)
console.log('\nquery median', times[10].toFixed(1), 'p90', times[18].toFixed(1), 'max', times[19].toFixed(1))

socket.end()
