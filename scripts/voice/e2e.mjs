// End-to-end check of the local voice engine under plain Node (worker_threads):
// pt-BR text → Kokoro WAV → Whisper → text, plus long-text, speed, voices,
// WebM/Ogg decoding and the host event loop's responsiveness during synthesis.
//
//   npx electron-vite build
//   node scripts/voice/e2e.mjs [--cache <dir>] [--out <dir>] [--profile small-fp32|small-q8|turbo-q8|turbo-q4]
//
// ffmpeg (if on PATH) is used ONLY to make WebM/Ogg fixtures from the WAV the
// engine produced — the engine itself never calls it.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { arg, defaultCache, dirArg, fmt, loadEngine, wer, withLoopProbe } from './lib.mjs'

const SHORT = 'Olá! Este é o motor de voz local do Agent Code, falando português do Brasil sem nenhum serviço na nuvem.'
const LONG = [
  'A inteligência artificial deixou de ser uma promessa distante e passou a fazer parte do trabalho de todos os dias.',
  'Hoje, um programador pode pedir a um agente que leia o código, rode os testes e proponha uma correção, enquanto ele mesmo cuida de outra tarefa.',
  'Isso muda a forma como planejamos o dia: em vez de escrever cada linha, passamos a revisar, a decidir e a orientar.',
  'Mas a mudança também exige cuidado. Um agente que age sozinho precisa de limites claros, de registros do que fez e de alguém que confira o resultado antes de ele chegar ao cliente.',
  'Por isso, neste aplicativo, cada tarefa tem um escopo de escrita, cada passo deixa uma evidência e quem fecha o trabalho é sempre um revisor.',
  'A voz entra nessa história como um atalho: falar é mais rápido do que digitar, e ouvir a resposta enquanto se caminha pela casa libera as mãos e os olhos.',
  'Com o motor local, nada disso depende da internet depois do primeiro download dos modelos.',
  'O texto é convertido em fonemas pelo eSpeak, a voz é gerada pelo Kokoro e a transcrição fica por conta do Whisper, tudo rodando no processador da própria máquina.',
  'O resultado não é perfeito, mas é privado, gratuito e está sempre disponível, mesmo quando a conexão cai no meio de uma conversa importante.',
  'Para quem trabalha em silêncio, basta desligar a leitura em voz alta; para quem prefere ouvir, dá para escolher entre três vozes e ajustar a velocidade.',
  'No fim das contas, a tecnologia só vale a pena quando some no fundo e deixa a gente pensar no que realmente importa.'
].join(' ')

const cache = dirArg('cache', defaultCache)
const out = dirArg('out', join(defaultCache, '..', 'agent-code-voice-e2e'))
const report = { cache, out, steps: {} }
const log = (...a) => console.log('[e2e]', ...a)

const eng = await loadEngine()
eng.setVoiceCacheDir(cache)
if (arg('profile')) eng.setWhisperProfile(arg('profile'))
const model = arg('profile', eng.WHISPER_PROFILE)

let lastPct = -1
const progress = (p) => {
  if (p.phase === 'download' && p.progress !== undefined) {
    const pct = Math.floor(p.progress * 10) * 10
    if (pct !== lastPct) log(`download ${p.model} ${p.file} ${pct}%`)
    lastPct = pct
  } else if (p.phase === 'ready') log(`pronto: ${p.model}`)
}

async function timed(fn) {
  const t0 = performance.now()
  const r = await fn()
  return [r, (performance.now() - t0) / 1000]
}

try {
  let [, s] = await timed(() => eng.prepareVoiceModels('tts', progress))
  report.steps.prepareTts = { seconds: s }
  log(`Kokoro + eSpeak carregados em ${fmt(s)} s`)

  // 1. Short synthesis, with the host event loop probed while the worker works.
  const probe = await withLoopProbe(() => timed(() => eng.synthesizeLocal(SHORT, { voice: 'pf_dora' })))
  const [short, shortSec] = probe.result
  writeFileSync(join(out, 'short_pf_dora.wav'), Buffer.from(short.base64, 'base64'))
  report.steps.short = { chars: SHORT.length, audioSec: short.durationSec, synthSec: shortSec, chunks: short.chunks, loop: { ticks: probe.ticks, maxLagMs: probe.maxLagMs, p99LagMs: probe.p99LagMs } }
  log(`curto: ${SHORT.length} chars → ${fmt(short.durationSec)} s de áudio em ${fmt(shortSec)} s; event loop: ${probe.ticks} ticks, lag máx ${fmt(probe.maxLagMs, 1)} ms, p99 ${fmt(probe.p99LagMs, 1)} ms`)

  // 2. Long text (~1500 chars): chunked, nothing truncated, duration ∝ length.
  const lp = await withLoopProbe(() => timed(() => eng.synthesizeLocal(LONG, { voice: 'pf_dora' })))
  const [long, longSec] = lp.result
  writeFileSync(join(out, 'long_pf_dora.wav'), Buffer.from(long.base64, 'base64'))
  const cpsShort = SHORT.length / short.durationSec
  const cpsLong = LONG.length / long.durationSec
  report.steps.long = { chars: LONG.length, audioSec: long.durationSec, synthSec: longSec, chunks: long.chunks, charsPerSec: cpsLong, charsPerSecShort: cpsShort, loop: { ticks: lp.ticks, maxLagMs: lp.maxLagMs, p99LagMs: lp.p99LagMs } }
  log(`longo: ${LONG.length} chars em ${long.chunks} pedaços → ${fmt(long.durationSec)} s de áudio em ${fmt(longSec)} s (${fmt(cpsLong, 1)} chars/s vs ${fmt(cpsShort, 1)} no curto); lag máx ${fmt(lp.maxLagMs, 1)} ms`)
  if (long.durationSec < 60) throw new Error('áudio longo curto demais: truncado?')
  if (Math.abs(cpsLong / cpsShort - 1) > 0.35) throw new Error('duração não proporcional ao texto')

  // 3. Native speed.
  const fast = await eng.synthesizeLocal(SHORT, { voice: 'pf_dora', speed: 1.5 })
  report.steps.speed = { speed: 1.5, audioSec: fast.durationSec, ratio: short.durationSec / fast.durationSec }
  log(`speed 1.5: ${fmt(fast.durationSec)} s (razão ${fmt(short.durationSec / fast.durationSec)})`)

  // 4. The other voices.
  for (const voice of ['pm_alex', 'pm_santa']) {
    const r = await eng.synthesizeLocal(SHORT, { voice })
    writeFileSync(join(out, `short_${voice}.wav`), Buffer.from(r.base64, 'base64'))
    report.steps[voice] = { audioSec: r.durationSec }
    log(`${voice}: ${fmt(r.durationSec)} s`)
  }

  // 5. Round trip through Whisper.
  ;[, s] = await timed(() => eng.prepareVoiceModels('stt', progress))
  report.steps.prepareStt = { model, seconds: s }
  log(`Whisper ${model} carregado em ${fmt(s)} s`)
  const trips = { 'short_pf_dora.wav': SHORT, 'short_pm_alex.wav': SHORT, 'short_pm_santa.wav': SHORT, 'long_pf_dora.wav': LONG }
  report.steps.roundTrip = {}
  for (const [file, ref] of Object.entries(trips)) {
    const b64 = readFileSync(join(out, file)).toString('base64')
    const [text, sec] = await timed(() => eng.transcribeWhisper(b64, 'audio/wav'))
    const w = wer(ref, text)
    report.steps.roundTrip[file] = { seconds: sec, wer: w, text }
    log(`${file}: WER ${fmt(w * 100, 1)}% em ${fmt(sec)} s → "${text.slice(0, 140)}${text.length > 140 ? '…' : ''}"`)
  }

  // 6. Phone formats (WebM/Opus, Ogg/Opus) decoded by the engine's WASM path.
  let ffmpeg = true
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  } catch {
    ffmpeg = false
    log('ffmpeg ausente: pulando fixtures WebM/Ogg')
  }
  if (ffmpeg) {
    report.steps.phone = {}
    const src = join(out, 'short_pf_dora.wav')
    for (const [ext, mime, codecArgs] of [
      ['webm', 'audio/webm;codecs=opus', ['-c:a', 'libopus', '-b:a', '32k']],
      ['ogg', 'audio/ogg;codecs=opus', ['-c:a', 'libopus', '-b:a', '32k']]
    ]) {
      const file = join(out, `short_pf_dora.${ext}`)
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', '48000', ...codecArgs, file])
      const [text, sec] = await timed(() => eng.transcribeWhisper(readFileSync(file).toString('base64'), mime))
      const w = wer(SHORT, text)
      report.steps.phone[ext] = { seconds: sec, wer: w, text }
      log(`${ext}: WER ${fmt(w * 100, 1)}% em ${fmt(sec)} s → "${text}"`)
    }
  }
} finally {
  await eng.stopVoiceEngine()
  writeFileSync(join(out, 'e2e-report.json'), JSON.stringify(report, null, 2))
  log(`relatório: ${join(out, 'e2e-report.json')}`)
}
