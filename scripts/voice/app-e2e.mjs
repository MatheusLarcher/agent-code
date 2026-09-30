// Drives the REAL app (built `out/`, a separate Electron instance with its own
// userData so the installed/running app is untouched) through the voice
// features over CDP, saving screenshots + a JSON log as evidence.
//
//   npm run build
//   node scripts/voice/app-e2e.mjs launch A      # fresh userData, empty model cache
//   node scripts/voice/app-e2e.mjs A              # Ouvir, Ler daqui, voz/velocidade, F5
//   node scripts/voice/app-e2e.mjs launch B      # restart with a fake mic fed by a Kokoro WAV
//   node scripts/voice/app-e2e.mjs B              # ditado pelo microfone, F5 e repetir
//   node scripts/voice/app-e2e.mjs stop
//
// Output: <tmp>/agent-code-voice-app-e2e/ (screens/*.png, log-*.json, dictation.wav).
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const ROOT = join(tmpdir(), 'agent-code-voice-app-e2e')
const UD = join(ROOT, 'userdata')
const SHOTS = join(ROOT, 'screens')
const PROJECT = join(ROOT, 'projeto')
const WAV = join(ROOT, 'dictation.wav')
const PORT = 9444
const PID_FILE = join(ROOT, 'electron.pid')
for (const d of [ROOT, SHOTS, PROJECT]) mkdirSync(d, { recursive: true })

const log = []
const note = (step, data = {}) => {
  const entry = { t: new Date().toISOString(), step, ...data }
  log.push(entry)
  console.log('[app-e2e]', step, JSON.stringify(data))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function launch(phase) {
  if (phase === 'A' && existsSync(UD)) rmSync(UD, { recursive: true, force: true })
  const electron = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
  const args = ['.', `--user-data-dir=${UD}`, `--remote-debugging-port=${PORT}`, '--autoplay-policy=no-user-gesture-required']
  if (phase === 'B') {
    if (!existsSync(WAV)) throw new Error(`falta ${WAV} (rode a fase A)`)
    args.push('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`)
  }
  // Sem ELECTRON_RENDERER_URL: carrega o renderer BUILDADO (out/renderer), não o
  // servidor de dev de outra instância que esteja rodando.
  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(electron, args, { cwd: process.cwd(), env, detached: true, stdio: ['ignore', 'ignore', 'ignore'] })
  child.unref()
  writeFileSync(PID_FILE, String(child.pid))
  console.log('[app-e2e] launched pid', child.pid, args.join(' '))
}

function stopApp() {
  if (!existsSync(PID_FILE)) return
  const pid = readFileSync(PID_FILE, 'utf8').trim()
  try {
    execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' })
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
        const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /index\.html|localhost/.test(p.url()) && !/about:blank/.test(p.url()))
        if (page) {
          // O app pode abrir um beforeunload no F5; aceita (ou ignora se já fechou).
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
  return file
}

/** Records every <audio> play (src mime, rate, duration) and speech-setup notices. */
async function instrument(page) {
  await page.evaluate(() => {
    if (window.__voiceProbe) return
    const probe = (window.__voiceProbe = { plays: [], setup: [] })
    const orig = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function () {
      const entry = { at: Date.now(), mime: String(this.src).slice(5, 30), rate: this.playbackRate, duration: null }
      probe.plays.push(entry)
      this.addEventListener('loadedmetadata', () => (entry.duration = this.duration), { once: true })
      if (Number.isFinite(this.duration)) entry.duration = this.duration
      return orig.call(this)
    }
    const seen = new Set()
    new MutationObserver(() => {
      const el = document.querySelector('.speech-setup')
      if (!el) return
      const text = el.textContent.trim()
      if (seen.has(text)) return
      seen.add(text)
      probe.setup.push({ at: Date.now(), cls: el.className, text })
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  })
}
const probe = (page) => page.evaluate(() => window.__voiceProbe)
const resetProbe = (page) => page.evaluate(() => { window.__voiceProbe.plays = []; window.__voiceProbe.setup = [] })

const ANSWER = [
  '## Resumo da tarefa',
  '',
  'A leitura em voz alta agora roda neste computador, sem chave nenhuma.',
  '',
  'Primeiro o app baixa o modelo de voz. Depois disso tudo funciona sem internet.',
  '',
  '- O ditado usa o Whisper local.',
  '- A velocidade vem pronta no áudio.',
  '',
  'Este é o último parágrafo, lido pelo botão Ler daqui.'
].join('\n')

async function seedConversation(page) {
  const now = Date.now()
  const conv = {
    id: 'conv-voz-e2e',
    title: 'Teste de voz local',
    titleSource: 'user',
    cwd: PROJECT,
    model: 'claude-opus-5-5',
    sdkSessionId: null,
    messages: [
      { kind: 'user', id: 'u1', text: 'Explique a voz local.' },
      { kind: 'assistant-text', id: 'a1', text: ANSWER, answer: true, ts: now }
    ],
    tokens: { context: 0, output: 0, cost: 0 },
    createdAt: now,
    updatedAt: now
  }
  await page.evaluate((c) => window.api.saveAllConversations([c]), conv)
  note('seeded conversation', { cwd: PROJECT })
}

async function openConversation(page) {
  const item = page.getByText('Teste de voz local').first()
  await item.waitFor({ timeout: 30_000 })
  await item.click()
  await page.locator('.msg-speak').first().waitFor({ timeout: 30_000 })
}

/** Click, then poll the probe until `plays` grows (or time out), snapshotting progress. */
async function clickAndWaitAudio(page, locator, label, { timeoutMs = 20 * 60_000, shotEveryMs = 20_000 } = {}) {
  const before = (await probe(page)).plays.length
  const t0 = Date.now()
  await locator.click()
  let lastShot = 0
  while (Date.now() - t0 < timeoutMs) {
    const p = await probe(page)
    if (p.plays.length > before) {
      note(`${label}: first audio`, { afterMs: Date.now() - t0, play: p.plays[before] })
      return Date.now() - t0
    }
    if (Date.now() - lastShot > shotEveryMs && (await page.locator('.speech-setup').count())) {
      lastShot = Date.now()
      note(`${label}: setup notice`, { text: await page.locator('.speech-setup').first().textContent() })
      await shot(page, `${label}-progresso`)
    }
    await sleep(400)
  }
  throw new Error(`${label}: nenhum áudio em ${timeoutMs} ms`)
}

async function stopSpeaking(page) {
  const active = page.locator('.msg-speak.active, .qc-read.active, button[aria-label="Parar leitura"]').first()
  if (await active.count()) await active.click().catch(() => {})
  await sleep(500)
}

function wavDuration(b64) {
  const buf = Buffer.from(b64, 'base64')
  const rate = buf.readUInt32LE(24)
  const dataBytes = buf.readUInt32LE(40)
  return { rate, seconds: dataBytes / 2 / rate }
}

async function phaseA(page) {
  await instrument(page)
  await shot(page, 'boot-cache-vazio')
  const cfg = await page.evaluate(() => window.api.getConfig())
  note('config inicial', { voice: cfg.voice, transcribeEngine: cfg.transcribeEngine, hasOpenai: 'openai' in cfg })

  await seedConversation(page)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await instrument(page)
  await openConversation(page)
  await shot(page, 'conversa')

  // 1) Ouvir — primeiro uso: baixa o Kokoro e mostra o progresso.
  const firstMs = await clickAndWaitAudio(page, page.locator('.msg-speak').first(), 'ouvir-1o-uso')
  await shot(page, 'ouvir-tocando')
  await sleep(4000)
  await stopSpeaking(page)
  note('ouvir 1º uso', { ms: firstMs, probe: await probe(page) })

  // 2) Ouvir de novo — modelo já carregado: sem aviso, rápido.
  await resetProbe(page)
  const warmMs = await clickAndWaitAudio(page, page.locator('.msg-speak').first(), 'ouvir-2a-vez')
  await sleep(2000)
  await stopSpeaking(page)
  note('ouvir 2ª vez', { ms: warmMs, probe: await probe(page) })

  // 3) Ler daqui no último parágrafo.
  await resetProbe(page)
  const para = page.locator('.msg.assistant p', { hasText: 'último parágrafo' }).first()
  await para.hover()
  const readBtn = para.locator('xpath=ancestor-or-self::*[.//button[@aria-label="Ler daqui"]][1]').locator('button[aria-label="Ler daqui"]').first()
  await shot(page, 'ler-daqui-hover')
  const lerMs = await clickAndWaitAudio(page, readBtn, 'ler-daqui')
  await shot(page, 'ler-daqui-tocando')
  // Espera a leitura terminar: começa no último parágrafo, então é curta.
  for (let i = 0; i < 60 && (await page.locator('button[aria-label="Parar leitura"]').count()); i++) await sleep(500)
  note('ler daqui', { ms: lerMs, probe: await probe(page) })

  // 4) Velocidade nativa: mesmo texto a 1× e 1,5× (duração do WAV), nas 3 vozes.
  const sample = 'A reunião foi remarcada para quinta-feira às três da tarde.'
  const speeds = {}
  for (const voice of ['pf_dora', 'pm_alex', 'pm_santa']) {
    for (const speed of [1, 1.5]) {
      const r = await page.evaluate(([t, o]) => window.api.speak(t, o), [sample, { voice, speed }])
      speeds[`${voice}@${speed}`] = r.ok ? { mime: r.mimeType, ...wavDuration(r.audioBase64) } : { error: r.error }
    }
  }
  note('duração por voz/velocidade', speeds)
  await phaseA2(page)
}

async function phaseA2(page) {
  shotN = Math.max(shotN, 20)
  await instrument(page)
  if (!(await page.locator('.msg-speak').count())) await openConversation(page)
  // 5) Troca de voz e velocidade pela tela de Configurações (+ Testar voz), salvar e Ouvir.
  if (!(await page.getByText('Ditado e leitura').count())) {
    await page.locator('button[title*="Configura"], button[aria-label*="Configura"]').first().click()
  }
  await page.getByText('Ditado e leitura').first().click()
  await page.locator('select').filter({ has: page.locator('option[value="pm_alex"]') }).selectOption('pm_alex')
  await page.locator('select').filter({ has: page.locator('option[value="1.5"]') }).selectOption('1.5')
  await shot(page, 'config-voz')
  await resetProbe(page)
  await clickAndWaitAudio(page, page.getByRole('button', { name: 'Testar voz' }), 'testar-voz', { timeoutMs: 120_000 })
  note('testar voz', { probe: await probe(page) })
  await sleep(3000)
  await page.getByRole('button', { name: /^Salvar/ }).first().click()
  await sleep(1000)
  const saved = await page.evaluate(() => window.api.getConfig())
  note('config salva', { voice: saved.voice })
  await resetProbe(page)
  await clickAndWaitAudio(page, page.locator('.msg-speak').first(), 'ouvir-alex-1.5')
  await sleep(3000)
  await stopSpeaking(page)
  note('ouvir com pm_alex 1.5', { probe: await probe(page) })

  // 6) F5 e repetir Ouvir.
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await instrument(page)
  await openConversation(page)
  const afterReloadMs = await clickAndWaitAudio(page, page.locator('.msg-speak').first(), 'ouvir-apos-F5')
  await shot(page, 'ouvir-apos-F5')
  await sleep(2000)
  await stopSpeaking(page)
  note('ouvir após F5', { ms: afterReloadMs, probe: await probe(page) })

  // 7) WAV do próprio Kokoro para alimentar o microfone falso na fase B.
  const dict = await page.evaluate(() =>
    window.api.speak('Olá, este é um teste de ditado pelo microfone.', { voice: 'pf_dora', speed: 1 })
  )
  const silence = Buffer.alloc(24000 * 2 * 1.5) // 1,5 s de silêncio: o VAD fecha o segmento
  const pcm = Buffer.concat([Buffer.from(dict.audioBase64, 'base64').subarray(44), silence])
  const header = Buffer.from(dict.audioBase64, 'base64').subarray(0, 44)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.writeUInt32LE(pcm.length, 40)
  writeFileSync(WAV, Buffer.concat([header, pcm]))
  note('wav do ditado gravado', { file: WAV, ...wavDuration(Buffer.concat([header, pcm]).toString('base64')) })
  // Volta a config para o padrão, para a fase B começar limpa.
  await page.evaluate(() => window.api.setConfig({ voice: { voice: 'pf_dora', speed: 1 } }))
}

async function dictate(page, label) {
  const composer = page.locator('.composer-row').first()
  const mic = composer.locator('.mic-btn').first()
  const editor = page.locator('.composer [contenteditable="true"], .composer textarea').first()
  const t0 = Date.now()
  await mic.click()
  let lastShot = 0
  let text = ''
  while (Date.now() - t0 < 20 * 60_000) {
    text = ((await editor.textContent()) || (await editor.inputValue().catch(() => '')) || '').trim()
    if (text) break
    if (Date.now() - lastShot > 20_000) {
      lastShot = Date.now()
      if (await page.locator('.speech-setup').count()) note(`${label}: setup notice`, { text: await page.locator('.speech-setup').first().textContent() })
      await shot(page, `${label}-aguardando`)
    }
    await sleep(500)
  }
  await shot(page, `${label}-texto`)
  await mic.click() // para
  await sleep(1500)
  text = ((await editor.textContent()) || '').trim()
  note(label, { ms: Date.now() - t0, text })
  // Limpa a caixa para a próxima rodada.
  await editor.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  return text
}

async function phaseB(page) {
  await instrument(page)
  await openConversation(page)
  await shot(page, 'fase-b-boot')
  const cfg = await page.evaluate(() => window.api.getConfig())
  note('config fase B', { voice: cfg.voice, transcribeEngine: cfg.transcribeEngine })
  await dictate(page, 'ditado-1o-uso')
  // IPC direto com o mesmo WAV (prova independente do caminho do microfone).
  const b64 = readFileSync(WAV).toString('base64')
  const r = await page.evaluate((a) => window.api.transcribeAudio(a, 'audio/wav'), b64)
  note('transcribe por IPC com WAV do Kokoro', r)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await instrument(page)
  await openConversation(page)
  await dictate(page, 'ditado-apos-F5')
  const ms = await clickAndWaitAudio(page, page.locator('.msg-speak').first(), 'ouvir-fase-b')
  await sleep(2000)
  await stopSpeaking(page)
  note('ouvir fase B (após reinício)', { ms, probe: await probe(page) })
}

process.on('uncaughtException', (err) => console.log('[app-e2e] ignorado:', String(err).slice(0, 160)))
const [cmd, arg] = process.argv.slice(2)
if (cmd === 'launch') launch(arg)
else if (cmd === 'stop') stopApp()
else if (cmd === 'A' || cmd === 'A2' || cmd === 'B') {
  const { browser, page } = await connect()
  try {
    await (cmd === 'A' ? phaseA(page) : cmd === 'A2' ? phaseA2(page) : phaseB(page))
    note('ok')
  } catch (err) {
    note('ERRO', { message: String(err?.stack ?? err) })
    await shot(page, 'erro').catch(() => {})
    process.exitCode = 1
  } finally {
    writeFileSync(join(ROOT, `log-${cmd}.json`), JSON.stringify(log, null, 2))
    await browser.close().catch(() => {})
  }
} else {
  console.log('uso: node scripts/voice/app-e2e.mjs launch A|B | A | B | stop')
}
