// Real-app check of the Parakeet dictation engine: a separate Electron instance
// (own userData and own model cache under it — the user's app and data
// untouched), driven over CDP.
//
//   npm run build
//   node scripts/voice/app-e2e-parakeet.mjs launch     # fresh userData: models download in the app
//   node scripts/voice/app-e2e-parakeet.mjs run [long.wav]
//   node scripts/voice/app-e2e-parakeet.mjs stop
//
// run: Settings › Voz → "Testar transcrição" (Kokoro speaks a pt-BR phrase,
// Parakeet transcribes it; the first time it downloads with progress on
// screen) → where it ran (voiceStatus + the Settings hint) → optionally a long
// WAV (> 30 s, e.g. long_pf_dora.wav of scripts/voice/e2e.mjs) through the same
// IPC the Composer uses. Output: <tmp>/agent-code-parakeet-app-e2e/ (screens,
// log-run.json, main.log with the engine's "[voice]" lines).
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const ROOT = join(tmpdir(), 'agent-code-parakeet-app-e2e')
const UD = join(ROOT, 'userdata')
const SHOTS = join(ROOT, 'screens')
const MAIN_LOG = join(ROOT, 'main.log')
const PID_FILE = join(ROOT, 'electron.pid')
const PORT = 9446
for (const d of [ROOT, SHOTS]) mkdirSync(d, { recursive: true })

const log = []
const note = (step, data = {}) => {
  log.push({ t: new Date().toISOString(), step, ...data })
  console.log('[parakeet-e2e]', step, JSON.stringify(data))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function launch() {
  if (existsSync(UD)) rmSync(UD, { recursive: true, force: true })
  const electron = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL // the BUILT renderer, not someone's dev server
  const out = openSync(MAIN_LOG, 'w')
  const child = spawn(electron, ['.', `--user-data-dir=${UD}`, `--remote-debugging-port=${PORT}`], {
    cwd: process.cwd(),
    env,
    detached: true,
    stdio: ['ignore', out, out]
  })
  child.unref()
  writeFileSync(PID_FILE, String(child.pid))
  console.log('[parakeet-e2e] launched pid', child.pid)
}

function stopApp() {
  if (!existsSync(PID_FILE)) return
  try {
    execFileSync('taskkill', ['/PID', readFileSync(PID_FILE, 'utf8').trim(), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* already gone */
  }
  rmSync(PID_FILE, { force: true })
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
      for (let j = 0; j < 60; j++) {
        const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /index\.html/.test(p.url()))
        if (page) {
          page.on('dialog', (d) => void d.accept().catch(() => {}))
          return { browser, page }
        }
        await sleep(500)
      }
    } catch {
      /* not up yet */
    }
    await sleep(1000)
  }
  throw new Error('app não respondeu no CDP')
}

let shotN = 0
async function shot(page, name) {
  const file = join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file })
  note('screenshot', { file })
}

async function openVoiceSettings(page) {
  await page.locator('button[title*="Configura"], button[aria-label*="Configura"]').first().click()
  await page.getByText('Ditado e leitura').first().click()
  await page.getByTestId('voice-install-stt').waitFor({ timeout: 10_000 })
}

async function selfTest(page) {
  const box = page.getByTestId('voice-install-stt')
  await box.getByRole('button', { name: 'Testar transcrição' }).click()
  const notices = new Set()
  const t0 = Date.now()
  let lastShot = 0
  while (Date.now() - t0 < 30 * 60_000) {
    if (await box.getByTestId('voice-test-result').count()) break
    const err = box.locator('[role="alert"]')
    if (await err.count()) throw new Error(`erro no teste: ${await err.first().textContent()}`)
    const st = box.locator('[role="status"]')
    if (await st.count()) {
      const n = ((await st.first().textContent()) || '').trim()
      if (n) notices.add(n.replace(/\d+%.*$/, '…'))
      if (Date.now() - lastShot > 20_000) {
        lastShot = Date.now()
        await shot(page, 'teste-progresso')
      }
    }
    await sleep(500)
  }
  const result = ((await box.getByTestId('voice-test-result').textContent()) || '').trim()
  await shot(page, 'teste-resultado')
  return { ms: Date.now() - t0, result, notices: [...notices].slice(0, 12) }
}

async function run(page, longWav) {
  rmSync(SHOTS, { recursive: true, force: true })
  mkdirSync(SHOTS, { recursive: true })
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await sleep(3000)
  note('status inicial', await page.evaluate(() => window.api.voiceStatus()))
  await openVoiceSettings(page)
  await shot(page, 'config-voz-inicial')
  const t1 = await selfTest(page)
  note('Testar transcrição (1º uso: baixa e carrega)', t1)
  const t2 = await selfTest(page)
  note('Testar transcrição (modelo já carregado)', t2)
  const status = await page.evaluate(() => window.api.voiceStatus())
  note('voiceStatus depois do teste', status)
  if (!/^Funcionando/.test(t1.result) || !/^Funcionando/.test(t2.result) || !status.device) throw new Error('autoteste falhou')
  await page.keyboard.press('Escape')
  await openVoiceSettings(page)
  await page.getByTestId('speech-device').filter({ hasText: 'rodando em' }).waitFor({ timeout: 10_000 })
  note('aba Voz', { device: await page.getByTestId('speech-device').textContent() })
  await shot(page, 'config-rodando-em')
  if (longWav) {
    const b64 = readFileSync(longWav).toString('base64')
    const t = Date.now()
    const r = await page.evaluate((a) => window.api.transcribeAudio(a, 'audio/wav'), b64)
    note('áudio longo pelo IPC do ditado', { file: longWav, ms: Date.now() - t, ...r })
    if (!r.ok || !r.text) throw new Error('transcrição do áudio longo falhou')
  }
  const voiceLines = readFileSync(MAIN_LOG, 'utf8').split(/\r?\n/).filter((l) => l.includes('[voice]'))
  note('log do main ([voice])', { lines: voiceLines })
}

process.on('uncaughtException', (err) => console.log('[parakeet-e2e] ignorado:', String(err).slice(0, 160)))
const [cmd, arg] = process.argv.slice(2)
if (cmd === 'launch') launch()
else if (cmd === 'stop') stopApp()
else if (cmd === 'run') {
  const { browser, page } = await connect()
  try {
    await run(page, arg)
    note('ok')
  } catch (err) {
    note('ERRO', { message: String(err?.stack ?? err) })
    await shot(page, 'erro').catch(() => {})
    process.exitCode = 1
  } finally {
    writeFileSync(join(ROOT, 'log-run.json'), JSON.stringify(log, null, 2))
    await browser.close().catch(() => {})
  }
} else console.log('uso: node scripts/voice/app-e2e-parakeet.mjs launch | run [long.wav] | stop')
