// Whisper benchmark for the local voice engine: latency and WER of each
// profile on ~5 s and ~15 s of pt-BR speech (synthesized once by Kokoro and
// reused). Picks the default: best quality with < ~3 s for 5 s of audio.
//
//   npx electron-vite build
//   node scripts/voice/bench-whisper.mjs [--cache <dir>] [--out <dir>] [--runs 3]
//        [--profiles small-fp32,turbo-q8] [--threads default,4,8,16]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { arg, defaultCache, dirArg, fmt, loadEngine, wer } from './lib.mjs'

const CLIPS = {
  '5s': { voice: 'pf_dora', text: 'Bom dia! Preciso que você revise o relatório de vendas antes do almoço.' },
  '15s': {
    voice: 'pm_alex',
    text: 'Na reunião de ontem ficou decidido que a equipe de suporte vai assumir o atendimento por telefone a partir de segunda-feira, e que os chamados abertos no sistema antigo serão migrados até o fim do mês, sem perder o histórico.'
  }
}
const LATENCY_BUDGET_5S = 3

const cache = dirArg('cache', defaultCache)
const out = dirArg('out', join(defaultCache, '..', 'agent-code-voice-bench'))
const runs = Number(arg('runs', '3'))
const eng = await loadEngine()
eng.setVoiceCacheDir(cache)
const profiles = arg('profiles', Object.keys(eng.WHISPER_PROFILES).join(',')).split(',')
const log = (...a) => console.log('[bench]', ...a)
const now = () => performance.now() / 1000
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

// Fixtures, synthesized once.
const clips = {}
for (const [name, { voice, text }] of Object.entries(CLIPS)) {
  const file = join(out, `clip_${name}.wav`)
  if (!existsSync(file)) {
    const r = await eng.synthesizeLocal(text, { voice })
    writeFileSync(file, Buffer.from(r.base64, 'base64'))
  }
  const wav = readFileSync(file)
  clips[name] = { text, b64: wav.toString('base64'), seconds: (wav.length - 44) / 2 / 24000 }
  log(`clip ${name}: ${fmt(clips[name].seconds)} s (${voice})`)
}
// Clean TTS speech is easy for every model; a noisy copy (white noise at
// ~5 dB SNR, fixed seed) is what separates them on quality.
{
  const wav = Buffer.from(clips['15s'].b64, 'base64')
  const n = (wav.length - 44) / 2
  let power = 0
  for (let i = 0; i < n; i++) power += (wav.readInt16LE(44 + i * 2) / 32768) ** 2
  const sigma = Math.sqrt(power / n)
  let seed = 12345
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const noisy = Buffer.from(wav)
  for (let i = 0; i < n; i++) {
    const g = Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand()) // Box-Muller
    const v = wav.readInt16LE(44 + i * 2) / 32768 + 0.56 * sigma * g // 0.56 ≈ 5 dB SNR
    noisy.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v * 0.5)) * 32767), 44 + i * 2)
  }
  writeFileSync(join(out, 'clip_15s_noisy.wav'), noisy)
  clips['15s-ruido'] = { text: clips['15s'].text, b64: noisy.toString('base64'), seconds: clips['15s'].seconds }
}
await eng.stopVoiceEngine()

// ONNX Runtime thread pools to try ("default" = the engine's own choice).
const threadSets = arg('threads', 'default').split(',')
const results = []
for (const threads of threadSets)
for (const profile of profiles) {
  if (threads === 'default') delete process.env.AGENT_CODE_VOICE_THREADS
  else process.env.AGENT_CODE_VOICE_THREADS = threads // read by the worker at spawn
  eng.setWhisperProfile(profile)
  const spec = eng.WHISPER_PROFILES[profile]
  log(`== ${profile} (${spec.model}, ${JSON.stringify(spec.dtype)}), threads=${threads}`)
  let downloaded = 0
  let t = now()
  await eng.prepareVoiceModels('stt', (p) => {
    if (p.phase === 'download' && p.progress === 1) downloaded += p.total ?? 0
  })
  const firstPrepareSec = now() - t
  await eng.stopVoiceEngine()
  t = now()
  await eng.prepareVoiceModels('stt') // load from the local cache only
  const loadSec = now() - t
  const rssMb = process.memoryUsage().rss / 1048576
  t = now()
  await eng.transcribeWhisper(clips['5s'].b64, 'audio/wav') // first inference (graph warm-up)
  const firstInferSec = now() - t
  const row = { profile, threads, model: spec.model, dtype: spec.dtype, downloadedMb: downloaded / 1048576, firstPrepareSec, loadSec, firstInferSec, rssMb }
  for (const [name, clip] of Object.entries(clips)) {
    const lat = []
    let text = ''
    for (let i = 0; i < runs; i++) {
      t = now()
      text = await eng.transcribeWhisper(clip.b64, 'audio/wav')
      lat.push(now() - t)
    }
    row[name] = { audioSec: clip.seconds, medianSec: median(lat), runs: lat, wer: wer(clip.text, text), text }
    log(`${name}: mediana ${fmt(median(lat))} s (${lat.map((x) => fmt(x)).join(', ')}), WER ${fmt(row[name].wer * 100, 1)}% → "${text}"`)
  }
  log(`carga ${fmt(loadSec)} s (1ª com download: ${fmt(firstPrepareSec)} s, ${fmt(downloaded / 1048576, 0)} MB), 1ª inferência ${fmt(firstInferSec)} s, RSS ${fmt(rssMb, 0)} MB`)
  results.push(row)
  await eng.stopVoiceEngine()
}

// Best quality within budget: lowest total WER among profiles fast enough;
// ties go to the bigger model (turbo), then to full precision (no
// quantization loss), then to the faster run.
const eligible = results.filter((r) => r['5s'].medianSec < LATENCY_BUDGET_5S)
const score = (r) => Object.keys(clips).reduce((s, k) => s + r[k].wer, 0)
const big = (r) => Number(r.model.includes('turbo'))
const full = (r) => Number(r.dtype === 'fp32')
const pick = eligible.sort((a, b) => score(a) - score(b) || big(b) - big(a) || full(b) - full(a) || a['5s'].medianSec - b['5s'].medianSec)[0]
const summary = {
  machine: { cpu: cpus()[0]?.model, threads: cpus().length, ramGb: totalmem() / 2 ** 30, node: process.version },
  budget5sSec: LATENCY_BUDGET_5S,
  choice: pick ? { profile: pick.profile, threads: pick.threads } : null,
  results
}
writeFileSync(join(out, 'bench-whisper.json'), JSON.stringify(summary, null, 2))
console.log(`\nperfil       | threads | carga s | ${Object.keys(clips).map((k) => `${k}: lat s / WER`).join(' | ')} | RSS MB`)
for (const r of results) {
  const cells = Object.keys(clips).map((k) => `${fmt(r[k].medianSec)} / ${fmt(r[k].wer * 100, 1)}%`)
  console.log(`${r.profile.padEnd(12)} | ${String(r.threads).padStart(7)} | ${fmt(r.loadSec).padStart(7)} | ${cells.join(' | ')} | ${fmt(r.rssMb, 0)}`)
}
log(`escolha: ${JSON.stringify(summary.choice)} — relatório em ${join(out, 'bench-whisper.json')}`)
