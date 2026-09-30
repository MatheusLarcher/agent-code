// Raw DirectML/CUDA probe for Whisper, straight on transformers (no worker) —
// how the GPU split in WHISPER_PROFILES was chosen. --clips is a folder with
// clip_5s.wav / clip_15s.wav (24 kHz, as written by bench-whisper.mjs).
//   node scripts/voice/probe-gpu.mjs --cache <dir> --clips <dir> [--model <repo>]
//        --device dml | cpu | <enc>:<dec> (dml:cpu) --dtype <enc>:<dec> (fp16:q8) [--dml-id N]
// On the dev machine (RTX 5050 = adapter 0, Intel UHD = 1): any dtype with the
// merged decoder on dml → "token_ids must be a non-empty array" (no tokens);
// dml:cpu fp16:q8 → 1.25 s / 3.0 s; dml:cpu q8:q8 → 1.65 / 3.4 s; --dml-id 1 → ~27 s.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { env, pipeline } from '@huggingface/transformers'
import ort from 'onnxruntime-node'
import { arg } from './lib.mjs'

env.cacheDir = arg('cache', '')
env.allowLocalModels = false
const clips = arg('clips', '')
const deviceArg = arg('device', 'cpu')
// --dtype enc:dec (e.g. fp16:q8); --device dml | cpu | enc:dec (e.g. dml:cpu); --dml-id N
const [encT, decT] = arg('dtype', 'q8:q8').split(':')
const dtype = { encoder_model: encT, decoder_model_merged: decT ?? encT }
const [encD, decD] = deviceArg.split(':')
const device = decD ? { encoder_model: encD, decoder_model_merged: decD } : encD
const dmlId = arg('dml-id', '')
if (dmlId) {
  // Pin the DirectML adapter without touching the CPU sessions.
  const create = ort.InferenceSession.create.bind(ort.InferenceSession)
  ort.InferenceSession.create = (model, opts) =>
    create(model, { ...opts, executionProviders: opts?.executionProviders?.map((ep) => (ep === 'dml' ? { name: 'dml', deviceId: Number(dmlId) } : ep)) })
}
const session_options = { intraOpNumThreads: 8, interOpNumThreads: 1 }

/** 24 kHz PCM16 WAV → 16 kHz float (linear). */
function wav16k(file) {
  const b = readFileSync(file)
  const n = (b.length - 44) / 2
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(44 + i * 2) / 32768
  const m = Math.floor((n * 2) / 3)
  const y = new Float32Array(m)
  for (let i = 0; i < m; i++) {
    const p = i * 1.5
    const j = Math.floor(p)
    y[i] = x[j] * (1 - (p - j)) + x[Math.min(n - 1, j + 1)] * (p - j)
  }
  return y
}

const now = () => performance.now() / 1000
let t = now()
const model = arg('model', 'onnx-community/whisper-large-v3-turbo')
const asr = await pipeline('automatic-speech-recognition', model, { device, dtype, session_options })
const res = { label: arg('label', deviceArg), load: +(now() - t).toFixed(2) }
for (const c of ['clip_5s.wav', 'clip_15s.wav']) {
  const pcm = wav16k(join(clips, c))
  const lat = []
  let text = ''
  for (let i = 0; i < 4; i++) {
    t = now()
    text = (await asr(pcm, { language: 'portuguese', task: 'transcribe' })).text
    lat.push(+(now() - t).toFixed(2))
  }
  res[c] = { lat, text }
}
console.log(JSON.stringify(res))
await asr.dispose()
