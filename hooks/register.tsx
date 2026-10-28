import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheTimers, Totals } from '../types'

const PANE = 'token-distribution'
const TITLE = 'Tokens'
const FIVE_MINUTES = 5 * 60_000
const ONE_HOUR = 60 * 60_000
// How often to look for new transcript rows; the timers tick every second.
const POLL_TICKS = 3

const EMPTY: Totals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  write5m: 0,
  write1h: 0,
  requests: 0,
  subagentRequests: 0,
}
const NO_TIMERS: CacheTimers = { until5m: null, until1h: null }

// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const totals = atom({ plugin: 'token-distribution', key: 'totals' } as const, EMPTY, {
  shape: 'totals-1',
})
const timers = atom({ plugin: 'token-distribution', key: 'timers' } as const, NO_TIMERS, {
  shape: 'timers-1',
})
const now = atom({ plugin: 'token-distribution', key: 'now' } as const, 0)
const problem = atom({ plugin: 'token-distribution', key: 'problem' } as const, null)
// Set when the person closes the pane, so a reload doesn't open it again.
const isHidden = atom({ plugin: 'token-distribution', key: 'isHidden' } as const, false)
// Tracked by the mod rather than read from `$.ui.panes()`, which once missed
// the open pane on desktop.
const isOpen = atom({ plugin: 'token-distribution', key: 'isOpen' } as const, false)

type ReaderRow = { id: string; t: number; i: number; o: number; r: number; w5: number; w1: number }
type ReaderOutput = {
  main: string | null
  files: { path: string; offset: number; rows: ReaderRow[] }[]
}
type FileScan = {
  offset: number
  seen: Set<string>
  until5m: number | null
  until1h: number | null
}

const KINDS = [
  { key: 'input', label: 'Input', color: '#5B8DEF' },
  { key: 'output', label: 'Output', color: '#D97757' },
  { key: 'cacheRead', label: 'Cache read', color: '#3BA374' },
  { key: 'write5m', label: 'Cache write 5m', color: '#9B7BE0' },
  { key: 'write1h', label: 'Cache write 1h', color: '#D45C9E' },
] as const

function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function clockText(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// Splits `cells` among the values by largest remainder, so the bar always
// fills its width exactly.
function apportion(values: number[], cells: number): number[] {
  const total = values.reduce((a, b) => a + b, 0)
  if (total === 0) return values.map(() => 0)
  const exact = values.map(v => (v / total) * cells)
  const whole = exact.map(Math.floor)
  let left = cells - whole.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left-- <= 0) break
    whole[i] = (whole[i] ?? 0) + 1
  }
  return whole
}

// Rebuilt from the transcripts after a reload, so module variables are enough.
const scanState = {
  sessionId: null as string | null,
  main: null as string | null,
  files: new Map<string, FileScan>(),
  sums: { ...EMPTY },
  lastFingerprint: '',
  isScanning: false,
}

function forget(): void {
  scanState.main = null
  scanState.files = new Map()
  scanState.sums = { ...EMPTY }
  scanState.lastFingerprint = ''
}

// Cheap check before spawning the reader: sizes of the transcripts.
async function fingerprint($: EngineInterface): Promise<string> {
  if (scanState.main === null || scanState.sessionId === null) return ''
  const parts: string[] = []
  try {
    parts.push(String((await $.fs.stat(scanState.main)).size))
  } catch {
    return ''
  }
  const folder = `${scanState.main.slice(0, -'.jsonl'.length)}/subagents`
  try {
    for (const entry of await $.fs.list(folder)) parts.push(`${entry.name}:${entry.size}`)
  } catch {
    // No subagent has run yet.
  }
  return parts.join('|')
}

async function scan($: EngineInterface, force: boolean): Promise<void> {
  if (scanState.isScanning) return
  scanState.isScanning = true
  try {
    const id = await $.session.id()
    if (id !== scanState.sessionId) {
      // A new session, or /clear started one.
      scanState.sessionId = id
      forget()
      force = true
    }
    const print = await fingerprint($)
    if (!force && print !== '' && print === scanState.lastFingerprint) return

    const offsets = Object.fromEntries([...scanState.files].map(([path, file]) => [path, file.offset]))
    const ran = await $.process.run(['node', `${$.plugin.root}/scripts/read-usage.mjs`], {
      stdin: JSON.stringify({ sessionId: id, main: scanState.main, offsets }),
      timeoutMs: 20_000,
    })
    if (ran.exitCode !== 0) {
      const reason = ran.stderr.trim().split('\n').pop() ?? `exit code ${ran.exitCode}`
      await update($, problem, () => `The usage reader failed: ${reason}`)
      return
    }
    const out = JSON.parse(ran.stdout) as ReaderOutput
    if (out.main === null) {
      await update($, problem, () => null)
      return
    }
    scanState.main = out.main

    for (const scanned of out.files) {
      const file = scanState.files.get(scanned.path) ?? { offset: 0, seen: new Set(), until5m: null, until1h: null }
      file.offset = scanned.offset
      scanState.files.set(scanned.path, file)
      for (const row of scanned.rows) {
        if (file.seen.has(row.id)) continue
        file.seen.add(row.id)
        scanState.sums.input += row.i
        scanState.sums.output += row.o
        scanState.sums.cacheRead += row.r
        scanState.sums.write5m += row.w5
        scanState.sums.write1h += row.w1
        scanState.sums.requests += 1
        if (scanned.path !== scanState.main) scanState.sums.subagentRequests += 1

        // A read hits the prefix this transcript cached and restarts the TTL
        // of each tier still alive; a write starts its own tier's.
        if (row.r > 0) {
          if (file.until5m !== null && file.until5m > row.t) file.until5m = row.t + FIVE_MINUTES
          if (file.until1h !== null && file.until1h > row.t) file.until1h = row.t + ONE_HOUR
        }
        if (row.w5 > 0) file.until5m = row.t + FIVE_MINUTES
        if (row.w1 > 0) file.until1h = row.t + ONE_HOUR
      }
    }

    const latest = (pick: (f: FileScan) => number | null): number | null =>
      [...scanState.files.values()].reduce<number | null>((best, f) => {
        const v = pick(f)
        return v !== null && (best === null || v > best) ? v : best
      }, null)
    const snapshot = { ...scanState.sums }
    await update($, totals, () => snapshot)
    await update($, timers, () => ({ until5m: latest(f => f.until5m), until1h: latest(f => f.until1h) }))
    await update($, problem, () => null)
    scanState.lastFingerprint = await fingerprint($)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Unawaited callers can't catch, so a failure to report the failure stops here.
    await update($, problem, () =>
      message.includes('ENOENT') || message.includes('not found')
        ? 'Node.js was not found on PATH; it reads the transcripts.'
        : `Could not read the transcripts: ${message}`,
    ).catch(() => undefined)
  } finally {
    scanState.isScanning = false
  }
}

async function openPane($: EngineInterface): Promise<void> {
  await update($, isHidden, () => false)
  await $.ui.open({ id: PANE, title: TITLE })
  // Open in the engine's record even when not yet placed, so it counts as open.
  await update($, isOpen, () => true)
  void scan($, true)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tokens', description: 'Show or hide the token distribution pane' })
    await update($, isOpen, () => false)
    if (!(await read($, isHidden))) void openPane($)

    await update($, now, () => 0)
    void scan($, true)
    let tick = 0
    $.clock.every(1000, async () => {
      tick += 1
      const at = await $.clock.now()
      const live = await read($, timers)
      // Redraw only while a countdown is running, or once more as it ends.
      const ending = Math.max(live.until5m ?? 0, live.until1h ?? 0)
      if (ending + 1000 > at) await update($, now, () => at)
      if (tick % POLL_TICKS === 0) await scan($, false)
    })

    return next(e)
  })

  on('session.end', ($, e, next) => {
    // /clear ends the session without a new session.start; the next scan
    // sees the new id and starts over.
    scanState.sessionId = null

    return next(e)
  })

  on('command.run', { command: 'tokens' }, async $ => {
    if (await read($, isOpen)) {
      await $.ui.close({ id: PANE })

      return { text: 'Token distribution pane closed.' }
    }
    await openPane($)

    return { text: 'Token distribution pane opened.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isOpen, () => false)
    if (e.origin.kind !== 'unload') await update($, isHidden, () => true)

    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const sum = await read($, totals)
    const live = await read($, timers)
    const issue = await read($, problem)
    const at = (await read($, now)) || (await $.clock.now())

    const values = KINDS.map(kind => sum[kind.key])
    const total = values.reduce((a, b) => a + b, 0)

    let bar
    if (e.surface === 'terminal') {
      const cells = apportion(values, Math.max(10, e.props.bodyColumns))
      bar =
        total === 0 ? (
          <Text dimColor>{'░'.repeat(Math.max(10, e.props.bodyColumns))}</Text>
        ) : (
          <Text>
            {KINDS.map((kind, i) => (
              <Text color={kind.color}>{'█'.repeat(cells[i] ?? 0)}</Text>
            ))}
          </Text>
        )
    } else {
      const { Svg } = $.ui.resolve(e)
      const widths = apportion(values, 1000)
      let x = 0
      const rects = KINDS.map((kind, i) => {
        const w = widths[i] ?? 0
        const rect = w > 0 ? `<rect x="${x}" y="0" width="${w}" height="10" fill="${kind.color}"/>` : ''
        x += w
        return rect
      }).join('')
      const track = total === 0 ? '<rect x="0" y="0" width="1000" height="10" fill="#8884"/>' : ''
      bar = (
        <Svg
          source={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 10" preserveAspectRatio="none" width="100%" height="10">${track}${rects}</svg>`}
          alt={KINDS.map((kind, i) => `${kind.label} ${values[i] ?? 0}`).join(', ')}
          height={10}
        />
      )
    }

    const countdown = (until: number | null) => {
      if (until === null) return <Text dimColor>Not written</Text>
      const left = until - at
      if (left <= 0) return <Text color="warning">Expired</Text>
      return (
        <Text tabular color="success">
          {clockText(left)} left
        </Text>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {issue !== null && <Text color="warning">{issue}</Text>}
        {bar}
        <Box flexDirection="column">
          {KINDS.map((kind, i) => {
            const value = values[i] ?? 0
            return (
              <Box flexDirection="row" justifyContent="space-between">
                <Text>
                  <Text color={kind.color}>● </Text>
                  {kind.label}
                </Text>
                <Box flexDirection="row" columnGap="sm">
                  <Text tabular>{compact(value)}</Text>
                  {/* A fixed-width column keeps the counts lined up whatever the percent. */}
                  <Box minWidth={6} justifyContent="flex-end">
                    <Text tabular dimColor>
                      {`${total > 0 ? ((value / total) * 100).toFixed(1) : '0.0'}%`}
                    </Text>
                  </Box>
                </Box>
              </Box>
            )
          })}
          <Box flexDirection="row" justifyContent="space-between">
            <Text weight="semibold">Total</Text>
            <Box flexDirection="row" columnGap="sm">
              <Text tabular weight="semibold">
                {compact(total)}
              </Text>
              <Box minWidth={6} justifyContent="flex-end">
                <Text tabular dimColor>
                  100%
                </Text>
              </Box>
            </Box>
          </Box>
          <Text dimColor size="footnote">
            {sum.requests === 0
              ? 'No API responses yet.'
              : `${sum.requests} API responses, ${sum.subagentRequests} from subagents`}
          </Text>
        </Box>
        <Box flexDirection="column">
          <Text weight="semibold">Cache timers</Text>
          <Box flexDirection="row" justifyContent="space-between">
            <Text>5m cache</Text>
            {countdown(live.until5m)}
          </Box>
          <Box flexDirection="row" justifyContent="space-between">
            <Text>1h cache</Text>
            {countdown(live.until1h)}
          </Box>
          <Text dimColor size="footnote">
            Each request that reads or writes a tier restarts its timer.
          </Text>
        </Box>
      </Box>
    )
  })
}
