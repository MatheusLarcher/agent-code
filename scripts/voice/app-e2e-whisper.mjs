// Real-app check of the Whisper model picker + GPU: a separate Electron instance
// (own userData, own model cache under it — the user's app and data untouched)
// dictates through a FAKE microphone fed with a Kokoro WAV, over CDP.
//
//   npm run build
//   node scripts/voice/app-e2e-whisper.mjs launch <kokoro.wav>   # e.g. clip_5s.wav of bench-whisper
//   node scripts/voice/app-e2e-whisper.mjs run
//   node scripts/voice/app-e2e-whisper.mjs stop
//
// Steps: default turbo (1st dictation downloads it, progress on screen) → where
// it ran (voiceStatus + Settings) → small via Settings, dictate → back to turbo,
// dictate → F5, dictate. Output: <tmp>/agent-code-whisper-app-e2e/ (screens,
// log-run.json, main.log with the engine's "[voice]" lines).
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const ROOT = join(tmpdir(), 'agent-code-whisper-app-e2e')
const UD = join(ROOT, 'userdata')
const SHOTS = join(ROOT, 'screens')
const PROJECT = join(ROOT, 'projeto')
const WAV = join(ROOT, 'dictation.wav')
const MAIN_LOG = join(ROOT, 'main.log')
const PID_FILE = join(ROOT, 'electron.pid')
const PORT = 9445
const EXPECTED = 'Bom dia! Preciso que você revise o relatório de vendas antes do almoço.'
for (const d of [ROOT, SHOTS, PROJECT]) mkdirSync(d, { recursive: true })

const log = []
const note = (step, data = {}) => {
  log.push({ t: new Date().toISOString(), step, ...data })
  console.log('[whisper-e2e]', step, JSON.stringify(data))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 24 kHz mono PCM16 WAV + 1.5 s of silence, so the VAD closes the segment. */
function writeMicWav(src) {
  const wav = readFileSync(src)
  const pcm = Buffer.concat([wav.subarray(44), Buffer.alloc(24000 * 2 * 1.5)])
  const header = Buffer.from(wav.subarray(0, 44))
  header.writeUInt32LE(36 + pcm.length, 4)
  header.writeUInt32LE(pcm.length, 40)
  writeFileSync(WAV, Buffer.concat([header, pcm]))
}

function launch(src) {
  if (!src || !existsSync(src)) throw new Error('informe o WAV do Kokoro (24 kHz mono) a usar como microfone')
  if (existsSync(UD)) rmSync(UD, { recursive: true, force: true })
  writeMicWav(src)
  const electron = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
  const args = [
    '.',
    `--user-data-dir=${UD}`,
    `--remote-debugging-port=${PORT}`,
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${WAV}`
  ]
  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL // the BUILT renderer, not someone's dev server
  const out = openSync(MAIN_LOG, 'w')
  const child = spawn(electron, args, { cwd: process.cwd(), env, detached: true, stdio: ['ignore', out, out] })
  child.unref()
  writeFileSync(PID_FILE, String(child.pid))
  console.log('[whisper-e2e] launched pid', child.pid)
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

async function openConversation(page) {
  const item = page.getByText('Teste do Whisper').first()
  await item.waitFor({ timeout: 30_000 })
  await item.click()
  await page.locator('.composer-row .mic-btn').first().waitFor({ timeout: 30_000 })
}

async function seed(page) {
  const now = Date.now()
  const conv = {
    id: 'conv-whisper-e2e',
    title: 'Teste do Whisper',
    titleSource: 'user',
    cwd: PROJECT,
    model: 'claude-opus-5-5',
    sdkSessionId: null,
    messages: [{ kind: 'user', id: 'u1', text: 'Ditado com o Whisper local.' }],
    tokens: { context: 0, output: 0, cost: 0 },
    createdAt: now,
    updatedAt: now
  }
  await page.evaluate((c) => window.api.saveAllConversations([c]), conv)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await openConversation(page)
}

const status = (page) => page.evaluate(() => window.api.voiceStatus())

/** Mic on → wait for text (screenshots of the download notice meanwhile) → mic off. */
async function dictate(page, label, model) {
  const mic = page.locator('.composer-row .mic-btn').first()
  const editor = page.locator('.composer [contenteditable="true"], .composer textarea').first()
  const read = async () => ((await editor.textContent()) || (await editor.inputValue().catch(() => '')) || '').trim()
  const notices = new Set()
  if (await read()) throw new Error(`${label}: a caixa não estava vazia antes do ditado`)
  const t0 = Date.now()
  await mic.click()
  let text = ''
  let lastShot = 0
  while (Date.now() - t0 < 30 * 60_000) {
    text = await read()
    // Text alone isn't proof (a late segment of the looping mic can land): the
    // engine must also report having run THIS model somewhere.
    if (text) {
      const s = await status(page)
      if (s.model === model && s.device) break
    }
    const setup = page.locator('.speech-setup')
    if (await setup.count()) {
      const n = ((await setup.first().textContent()) || '').trim()
      if (n && !notices.has(n)) notices.add(n)
      if (Date.now() - lastShot > 15_000) {
        lastShot = Date.now()
        await shot(page, `${label}-progresso`)
      }
    }
    await sleep(300)
  }
  const ms = Date.now() - t0
  await shot(page, `${label}-texto`)
  await mic.click()
  // The fake mic loops the WAV: a segment in flight may still land after "stop".
  // Wait until nothing arrives for 6 s, then clear, and make sure it stays clear.
  let stable = Date.now()
  let last = await read()
  while (Date.now() - stable < 6000) {
    await sleep(500)
    const now = await read()
    if (now !== last) (last = now), (stable = Date.now())
  }
  text = last
  const s = await status(page)
  note(label, { ms, text, status: s, notices: [...notices].slice(0, 12) })
  for (let i = 0; i < 3 && (await read()); i++) {
    await editor.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Delete')
    await sleep(2000)
  }
  return { text, ms, status: s }
}

async function openVoiceSettings(page) {
  await page.locator('button[title*="Configura"], button[aria-label*="Configura"]').first().click()
  await page.getByText('Ditado e leitura').first().click()
  await page.getByTestId('whisper-model').waitFor({ timeout: 10_000 })
}

async function pickModel(page, id, label) {
  await openVoiceSettings(page)
  await page.getByTestId('whisper-model').selectOption(id)
  await shot(page, `config-${label}`)
  await page.getByRole('button', { name: /^Salvar/ }).first().click()
  await sleep(800)
  const saved = await page.evaluate(() => window.api.getConfig())
  note(`config salva (${label})`, { whisperModel: saved.voice.whisperModel })
}

async function run(page) {
  rmSync(SHOTS, { recursive: true, force: true })
  mkdirSync(SHOTS, { recursive: true })
  await seed(page)
  const cfg = await page.evaluate(() => window.api.getConfig())
  note('config inicial (userData novo)', { voice: cfg.voice, transcribeEngine: cfg.transcribeEngine, status: await status(page) })
  await openVoiceSettings(page)
  await shot(page, 'config-inicial')
  await page.keyboard.press('Escape')

  const r1 = await dictate(page, 'turbo-1o-uso', 'turbo-q8')
  const r2 = await dictate(page, 'turbo-quente', 'turbo-q8')
  await openVoiceSettings(page)
  const deviceHint = page.getByTestId('whisper-device')
  await deviceHint.filter({ hasText: 'Rodando em' }).waitFor({ timeout: 10_000 }) // status arrives async
  note('aba Voz após o turbo', { device: await deviceHint.textContent() })
  await shot(page, 'config-rodando-em')
  await page.keyboard.press('Escape')

  await pickModel(page, 'small-fp32', 'small')
  const r3 = await dictate(page, 'small-1o-uso', 'small-fp32')
  await pickModel(page, 'turbo-q8', 'turbo-de-volta')
  const r4 = await dictate(page, 'turbo-de-volta', 'turbo-q8')

  await page.reload() // F5
  await page.waitForLoadState('domcontentloaded')
  await openConversation(page)
  const r5 = await dictate(page, 'turbo-apos-F5', 'turbo-q8')
  await openVoiceSettings(page)
  await deviceHint.filter({ hasText: 'Rodando em' }).waitFor({ timeout: 10_000 })
  note('aba Voz após F5', { model: await page.getByTestId('whisper-model').inputValue(), device: await deviceHint.textContent() })
  await shot(page, 'config-apos-F5')

  const want = [['turbo-q8', r1], ['turbo-q8', r2], ['small-fp32', r3], ['turbo-q8', r4], ['turbo-q8', r5]]
  for (const [model, r] of want) {
    if (r.status.model !== model || !r.status.device || !r.text) throw new Error(`esperava ${model} com texto e dispositivo: ${JSON.stringify(r)}`)
  }
  const voiceLines = readFileSync(MAIN_LOG, 'utf8').split(/\r?\n/).filter((l) => l.includes('[voice]'))
  note('log do main ([voice])', { lines: voiceLines })
  note('resumo', {
    esperado: EXPECTED,
    rodadas: [r1, r2, r3, r4, r5].map((r, i) => ({ i, ms: r.ms, device: r.status.device, model: r.status.model, text: r.text }))
  })
}

process.on('uncaughtException', (err) => console.log('[whisper-e2e] ignorado:', String(err).slice(0, 160)))
const [cmd, arg] = process.argv.slice(2)
if (cmd === 'launch') launch(arg)
else if (cmd === 'stop') stopApp()
else if (cmd === 'settings') {
  // F5 (picks up a rebuilt renderer) and a screenshot of Settings › Voz.
  const { browser, page } = await connect()
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await openConversation(page)
  await openVoiceSettings(page)
  await page.getByTestId('whisper-device').filter({ hasText: 'Rodando em' }).waitFor({ timeout: 10_000 }).catch(() => {})
  shotN = 90
  await shot(page, 'config-voz-apos-rebuild')
  await browser.close().catch(() => {})
} else if (cmd === 'ipc') {
  // Same WAV straight through the IPC (no VAD/looping mic): model switch proof.
  const { browser, page } = await connect()
  await page.evaluate((m) => window.api.setConfig({ voice: { whisperModel: m } }), arg ?? 'turbo-q8')
  const b64 = readFileSync(WAV).toString('base64')
  for (let i = 0; i < 2; i++) {
    const t = Date.now()
    const r = await page.evaluate((a) => window.api.transcribeAudio(a, 'audio/wav'), b64)
    note(`ipc ${arg} #${i + 1}`, { ms: Date.now() - t, ...r, status: await status(page) })
  }
  writeFileSync(join(ROOT, `log-ipc-${arg}.json`), JSON.stringify(log, null, 2))
  await browser.close().catch(() => {})
} else if (cmd === 'run') {
  const { browser, page } = await connect()
  try {
    await run(page)
    note('ok')
  } catch (err) {
    note('ERRO', { message: String(err?.stack ?? err) })
    await shot(page, 'erro').catch(() => {})
    process.exitCode = 1
  } finally {
    writeFileSync(join(ROOT, 'log-run.json'), JSON.stringify(log, null, 2))
    await browser.close().catch(() => {})
  }
} else console.log('uso: node scripts/voice/app-e2e-whisper.mjs launch <wav> | run | stop')
