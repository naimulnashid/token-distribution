import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const T0 = 1_800_000_000_000
const MAIN = 'C:/projects/p/sess.jsonl'

// What the reader script prints: two main-thread responses (the first stored
// twice, as a transcript does for each content block) and one subagent's.
const READER = {
  main: MAIN,
  files: [
    {
      path: MAIN,
      offset: 100,
      rows: [
        { id: 'm1', t: T0 - 60_000, i: 10, o: 200, r: 0, w5: 0, w1: 5000 },
        { id: 'm1', t: T0 - 60_000, i: 10, o: 200, r: 0, w5: 0, w1: 5000 },
        { id: 'm2', t: T0 - 30_000, i: 5, o: 300, r: 5000, w5: 0, w1: 1000 },
      ],
    },
    {
      path: 'C:/projects/p/sess/subagents/agent-a.jsonl',
      offset: 50,
      rows: [{ id: 's1', t: T0 - 120_000, i: 2, o: 100, r: 0, w5: 3000, w1: 0 }],
    },
  ],
}

const PANE = {
  plugin: 'token-distribution',
  component: 'Pane',
  requestId: 'token-distribution',
  props: {
    title: 'Tokens',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

function engine(on: On, panes: 'stub' | 'own' = 'stub'): void {
  // Nothing sits beneath the plugin: each hook here stands for the engine.
  on('command.register', () => ({ value: { command: 'tokens' } }))
  if (panes === 'stub') on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess' }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 100, mtimeMs: 0, isLink: false } }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: JSON.stringify(READER),
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
}

test('the pane sums each kind once per response, on every surface', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: T0 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Total$/ }))?.text).toBe('Total')
    // 17 + 600 + 5000 + 3000 + 6000
    expect(await ui.find({ type: 'Text', text: /^14\.6k$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /3 API responses, 1 from subagents/ })).toBeDefined()
    // The subagent wrote 5m two minutes ago; the main thread last read 1h 30s ago.
    expect(await ui.find({ type: 'Text', text: /^3:00 left$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^59:30 left$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a tier counts down and then reads expired', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: T0 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  await clock.advance(181_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Expired$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^56:29 left$/ })).toBeDefined()
  await ui.unmount()
})

test('/tokens closes an open pane and opens a closed one, and a close sticks', async ($, on) => {
  engine(on, 'own')
  const clock = mock.clock(on, { now: T0 })
  const open = new Set<string>()
  on('ui.open', (_, e) => {
    open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: [...open].map(id => ({ id, title: 'Tokens', isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.close', (_, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(open.has('token-distribution')).toBe(true)

  const run = { command: 'tokens', args: '', origin: { kind: 'person' }, presentation: {} } as never
  expect((await $.command.run(run)) as unknown).toMatchObject({ text: 'Token distribution pane closed.' })
  expect(open.has('token-distribution')).toBe(false)

  // A reload runs session.start again; a pane the person closed stays closed.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(open.has('token-distribution')).toBe(false)

  expect((await $.command.run(run)) as unknown).toMatchObject({ text: 'Token distribution pane opened.' })
  expect(open.has('token-distribution')).toBe(true)
  // Let the scan the open started finish before the test ends.
  await clock.settle()
})

test('before any response the pane says so', async ($, on) => {
  mock.clock(on, { now: T0 })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No API responses yet/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Not written$/ })).toBeDefined()
  await ui.unmount()
})
