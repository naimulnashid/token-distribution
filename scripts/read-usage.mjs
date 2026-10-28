// Prints the API usage of each response in a session's transcripts, read
// from byte offsets. The mod can't do this itself: its own file reads stop
// at 4 MiB and can't start mid-file, and long transcripts pass that.
//
// stdin:  { sessionId, main?, offsets: { [path]: byteOffset } }
// stdout: { main, files: [{ path, offset, rows: [{ id, t, i, o, r, w5, w1 }] }] }
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const input = JSON.parse(readFileSync(0, 'utf8'))
const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

function findMain() {
  const projects = join(configDir, 'projects')
  if (!existsSync(projects)) return null
  for (const dir of readdirSync(projects, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const path = join(projects, dir.name, `${input.sessionId}.jsonl`)
    if (existsSync(path)) return path
  }
  return null
}

function readFrom(path, offset) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    // A file shorter than our offset was rewritten: start it over.
    const start = size < offset ? 0 : offset
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    // Stop at the last full line; a row still being written waits for the next read.
    const end = buf.lastIndexOf(0x0a)
    if (end < 0) return { offset: start, text: '' }
    return { offset: start + end + 1, text: buf.subarray(0, end).toString('utf8') }
  } finally {
    closeSync(fd)
  }
}

function usageRows(text) {
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const usage = row?.message?.usage
    if (row.type !== 'assistant' || !usage) continue
    const split = usage.cache_creation
    const written = usage.cache_creation_input_tokens ?? 0
    rows.push({
      // One response is stored as a row per content block, each with the same usage.
      id: row.message.id ?? row.requestId ?? row.uuid,
      t: Date.parse(row.timestamp) || 0,
      i: usage.input_tokens ?? 0,
      o: usage.output_tokens ?? 0,
      r: usage.cache_read_input_tokens ?? 0,
      // Without the split the write used the API's default TTL, 5 minutes.
      w5: split ? (split.ephemeral_5m_input_tokens ?? 0) : written,
      w1: split ? (split.ephemeral_1h_input_tokens ?? 0) : 0,
    })
  }
  return rows
}

const main = input.main ?? findMain()
const files = []
if (main && existsSync(main)) {
  const paths = [main]
  const subagents = join(dirname(main), input.sessionId, 'subagents')
  if (existsSync(subagents)) {
    for (const name of readdirSync(subagents)) {
      if (name.endsWith('.jsonl')) paths.push(join(subagents, name))
    }
  }
  for (const path of paths) {
    const { offset, text } = readFrom(path, input.offsets?.[path] ?? 0)
    files.push({ path, offset, rows: usageRows(text) })
  }
}
process.stdout.write(JSON.stringify({ main: files.length ? main : null, files }))
