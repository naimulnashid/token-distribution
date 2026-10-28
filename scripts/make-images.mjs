// Makes the repository's images with headless Chrome:
//   assets/icon.png                  512 px, from assets/icon.svg (the plugin listing wants a PNG)
//   docs/screenshots/pane-dark.png   the Tokens pane in the desktop app's dark theme
//   docs/screenshots/pane-light.png  the same in the light theme
//
//   node scripts/make-images.mjs
//
// The pane is drawn here from INVENTED figures, imitating how the desktop app
// lays out the mod's tree; it is not captured from the app, which a script
// cannot drive. Keep the layout in step with hooks/register.tsx when it changes.
// Set CHROME to a Chrome or Edge executable when none is found.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const DEMO = {
  input: 2_140,
  output: 61_300,
  cacheRead: 3_912_000,
  write5m: 48_600,
  write1h: 211_500,
  requests: 42,
  subagentRequests: 9,
  left5m: 3 * 60_000 + 12_000,
  left1h: 52 * 60_000 + 40_000,
}

// The same kinds, colours and formatting as hooks/register.tsx.
const KINDS = [
  { key: 'input', label: 'Input', color: '#5B8DEF' },
  { key: 'output', label: 'Output', color: '#D97757' },
  { key: 'cacheRead', label: 'Cache read', color: '#3BA374' },
  { key: 'write5m', label: 'Cache write 5m', color: '#9B7BE0' },
  { key: 'write1h', label: 'Cache write 1h', color: '#D45C9E' },
]

function compact(n) {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function clockText(ms) {
  const seconds = Math.ceil(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const THEMES = {
  dark: { bg: '#1a1a1a', text: '#ececec', dim: '#9b9b9b', rule: '#2c2c2c', success: '#5cc46a' },
  light: { bg: '#ffffff', text: '#1d1d1d', dim: '#6b6b6b', rule: '#e6e6e6', success: '#2e7d32' },
}

function paneHtml(theme) {
  const t = THEMES[theme]
  const values = KINDS.map(k => DEMO[k.key])
  const total = values.reduce((a, b) => a + b, 0)
  let x = 0
  const segments = KINDS.map((k, i) => {
    const w = (values[i] / total) * 100
    const s = `<div style="position:absolute;left:${x}%;width:${w}%;top:0;bottom:0;background:${k.color}"></div>`
    x += w
    return s
  }).join('')
  const row = (left, count, pct, strong = false) => `
    <div class="row${strong ? ' strong' : ''}"><span>${left}</span>
      <span class="nums"><span>${count}</span><span class="pct">${pct}</span></span></div>`
  const rows = KINDS.map((k, i) =>
    row(`<span style="color:${k.color}">●</span> ${k.label}`, compact(values[i]), `${((values[i] / total) * 100).toFixed(1)}%`),
  ).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; background: ${t.bg}; }
    body { width: 420px; font: 15px/1.45 "Segoe UI", system-ui, sans-serif; color: ${t.text}; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid ${t.rule}; font-size: 16px; }
    header svg { stroke: ${t.text}; fill: none; stroke-width: 1.6; margin-left: 14px; }
    main { padding: 16px; display: flex; flex-direction: column; gap: 16px; }
    .bar { position: relative; height: 10px; }
    .row { display: flex; justify-content: space-between; }
    .nums { display: flex; gap: 8px; font-variant-numeric: tabular-nums; }
    .pct { color: ${t.dim}; min-width: 6ch; text-align: right; font-weight: 400; }
    .strong { font-weight: 600; }
    .note { color: ${t.dim}; font-size: 13px; }
    .left { color: ${t.success}; font-variant-numeric: tabular-nums; }
  </style></head><body>
    <header><span>Tokens</span><span>
      <svg width="16" height="16" viewBox="0 0 16 16"><path d="M9 2h5v5M14 2 9 7M7 14H2V9M2 14l5-5"/></svg>
      <svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 3l10 10M13 3 3 13"/></svg>
    </span></header>
    <main>
      <div class="bar">${segments}</div>
      <div>${rows}${row('Total', compact(total), '100%', true)}
        <div class="note">${DEMO.requests} API responses, ${DEMO.subagentRequests} from subagents</div></div>
      <div><div class="strong">Cache timers</div>
        <div class="row"><span>5m cache</span><span class="left">${clockText(DEMO.left5m)} left</span></div>
        <div class="row"><span>1h cache</span><span class="left">${clockText(DEMO.left1h)} left</span></div>
        <div class="note">Each request that reads or writes a tier restarts its timer.</div></div>
    </main></body></html>`
}

function findChrome() {
  const candidates = [
    process.env.CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
  const found = candidates.find(c => c && existsSync(c))
  if (!found) throw new Error('No Chrome or Edge found; set CHROME to its executable.')
  return found
}

const chrome = findChrome()
const work = mkdtempSync(join(tmpdir(), 'token-images-'))

function shoot(html, out, width, height, scale) {
  const page = join(work, 'page.html')
  writeFileSync(page, html)
  mkdirSync(dirname(out), { recursive: true })
  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    // A profile of its own, so a running browser is never touched.
    `--user-data-dir=${join(work, 'profile')}`,
    `--force-device-scale-factor=${scale}`,
    `--window-size=${width},${height}`,
    '--default-background-color=00000000',
    `--screenshot=${out}`,
    pathToFileURL(page).href,
  ], { stdio: 'ignore' })
  console.log(`wrote ${out}`)
}

try {
  const svg = readFileSync(join(ROOT, 'assets', 'icon.svg'), 'utf8')
  shoot(
    `<!doctype html><html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="512" height="512" ')}</body></html>`,
    join(ROOT, 'assets', 'icon.png'), 512, 512, 1,
  )
  for (const theme of ['dark', 'light']) {
    shoot(paneHtml(theme), join(ROOT, 'docs', 'screenshots', `pane-${theme}.png`), 420, 372, 2)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
