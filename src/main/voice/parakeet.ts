/**
 * Parakeet TDT 0.6B v3 (int8 ONNX) inside the voice worker, straight on
 * onnxruntime-node — no Python, no transformers pipeline.
 *
 *   waveform 16 kHz ─ nemo128.onnx (CPU) ─ encoder (GPU or CPU) ─ TDT greedy
 *   decoding with decoder_joint (CPU, one small run per step; tdt.ts)
 *
 * Only the ENCODER goes to the GPU: it is the heavy, single pass; the
 * decoder+joint is hundreds of tiny runs where a GPU round-trip costs more than
 * it saves, and the preprocessor is a few milliseconds of STFT.
 *
 * GPU = CUDA when this onnxruntime-node build has it, else DirectML (Windows;
 * runs on NVIDIA cards too). Any of these sends the encoder to the CPU, silently
 * for the user and logged for us:
 *   - the GPU session fails to be created (no driver, EP error);
 *   - the warm-up fails or is slower than WARMUP_BUDGET_SEC;
 *   - a real transcription fails on the GPU (retried on the CPU at once).
 * Each is remembered in `parakeet-gpu.json` so later launches go straight to
 * the CPU; errors are retried after a while (driver updates), see gpuVerdict.ts.
 * Env: AGENT_CODE_VOICE_DEVICE=cpu forces the CPU; =gpu skips the speed guard;
 * AGENT_CODE_VOICE_GPU_BUDGET_SEC overrides WARMUP_BUDGET_SEC.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ort from 'onnxruntime-node'
import { planChunks } from './chunking'
import { activeVerdict, clearVerdict, rememberVerdict } from './gpuVerdict'
import { sessionOptions, type Progress } from './models'
import { ensureParakeetFiles } from './parakeetFiles'
import { deviceLabel, gpuDeviceFor, PARAKEET_FILES, PARAKEET_MODEL, type SttDevice, type SttState } from './protocol'
import { detokenize, parseVocab, tdtGreedyDecode, type Vocab } from './tdt'

type Session = ort.InferenceSession
type Tensor = ort.Tensor

/** Slowest acceptable warm-up: 2 s of audio through the whole chain, after the
 *  first (setup) run. The CPU does it in well under this on the dev machine;
 *  a GPU slower than that is not worth using. */
const WARMUP_BUDGET_SEC = 1.5
const SAMPLE_RATE = 16000
/** Decoder (prediction network) LSTM state: layers × hidden, from the export
 *  (input_states_1/2 are [2, batch, 640]; scripts/voice/probe-parakeet.mjs). */
const STATE_LAYERS = 2
const STATE_HIDDEN = 640

interface Engine {
  pre: Session
  enc: Session
  dec: Session
  vocab: Vocab
  device: SttDevice
  gpuError?: string
}

let cacheDir = ''
let engine: Promise<Engine> | null = null
/** Set when the GPU failed in this worker; the next load goes straight to the CPU. */
let gpuBroken: string | null = null

const log = (msg: string): void => console.log(`[voice] ${msg}`)
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 300)

export function setParakeetCache(dir: string): void {
  cacheDir = dir
}

/** Runtime identity for the GPU verdicts (gpuVerdict.ts): a new onnxruntime-node retries the GPU. */
const runtimeVersion = (): string => ort.env.versions?.node ?? ort.env.versions?.common ?? ''

// ------------------------------------------------------------ inference

function create(path: string, device: SttDevice): Promise<Session> {
  return ort.InferenceSession.create(path, {
    ...sessionOptions(),
    executionProviders: [device],
    // DirectML can't run with memory patterns or parallel execution.
    ...(device === 'dml' ? { enableMemPattern: false, executionMode: 'sequential' as const } : {})
  })
}

const i64 = (values: number[], dims: number[]): Tensor => new ort.Tensor('int64', BigInt64Array.from(values.map(BigInt)), dims)
const i32 = (values: number[], dims: number[]): Tensor => new ort.Tensor('int32', Int32Array.from(values), dims)
const zeroState = (): Tensor => new ort.Tensor('float32', new Float32Array(STATE_LAYERS * STATE_HIDDEN), [STATE_LAYERS, 1, STATE_HIDDEN])

/** Text for one window of 16 kHz audio. */
async function recognize(e: Engine, samples: Float32Array): Promise<string> {
  const pre = await e.pre.run({
    waveforms: new ort.Tensor('float32', samples, [1, samples.length]),
    waveforms_lens: i64([samples.length], [1])
  })
  const enc = await e.enc.run({ audio_signal: pre.features, length: pre.features_lens })
  const out = enc.outputs // [1, D, T]
  const [, dim, frames] = out.dims
  const valid = Math.min(frames, Number((enc.encoded_lengths.data as BigInt64Array)[0]))
  const data = out.data as Float32Array
  const frame = new Float32Array(dim)
  const vocabSize = e.vocab.pieces.length
  const { tokens } = await tdtGreedyDecode(valid, e.vocab.blank, [zeroState(), zeroState()] as [Tensor, Tensor], async (t, prev, state) => {
    for (let d = 0; d < dim; d++) frame[d] = data[d * frames + t]
    const r = await e.dec.run({
      encoder_outputs: new ort.Tensor('float32', frame.slice(), [1, dim, 1]),
      targets: i32([prev], [1, 1]),
      target_length: i32([1], [1]),
      input_states_1: state[0],
      input_states_2: state[1]
    })
    const logits = r.outputs.data as Float32Array
    return {
      tokenLogits: logits.subarray(0, vocabSize),
      durationLogits: logits.subarray(vocabSize),
      state: [r.output_states_1, r.output_states_2] as [Tensor, Tensor]
    }
  })
  return detokenize(tokens, e.vocab)
}

async function run(e: Engine, pcm: Float32Array, onProgress: Progress): Promise<string> {
  const chunks = planChunks(pcm, SAMPLE_RATE)
  const parts: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    onProgress({ phase: 'transcribe', progress: i / chunks.length })
    const [a, b] = chunks[i]
    const text = await recognize(e, pcm.subarray(a, b))
    if (text) parts.push(text)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

// ------------------------------------------------------------ loading

async function release(...sessions: Array<Session | null | undefined>): Promise<void> {
  await Promise.all(sessions.map((s) => s?.release().catch(() => undefined)))
}

/** GPU encoder that ran the warm-up fast enough, or the reason it didn't. */
async function tryGpu(base: Omit<Engine, 'enc' | 'device'>, encPath: string, device: Exclude<SttDevice, 'cpu'>): Promise<Session | string> {
  let enc: Session | null = null
  try {
    enc = await create(encPath, device)
    // Low noise, not zeros: the preprocessor normalizes by the variance.
    const probe = Float32Array.from({ length: 2 * SAMPLE_RATE }, () => (Math.random() - 0.5) * 1e-3)
    // The first run pays one-time graph setup on the GPU; the second is what
    // every dictation will cost, and what tells a real GPU from a weak one.
    await recognize({ ...base, enc, device }, probe)
    const t = performance.now()
    await recognize({ ...base, enc, device }, probe)
    const sec = (performance.now() - t) / 1000
    log(`Parakeet: aquecimento na ${deviceLabel(device)} em ${sec.toFixed(2)} s`)
    const budget = Number(process.env.AGENT_CODE_VOICE_GPU_BUDGET_SEC) || WARMUP_BUDGET_SEC
    if (sec > budget && process.env.AGENT_CODE_VOICE_DEVICE !== 'gpu') {
      const reason = `aquecimento em ${sec.toFixed(1)} s na ${deviceLabel(device)} (limite ${budget} s)`
      rememberVerdict(cacheDir, device, 'slow', reason, runtimeVersion())
      await release(enc)
      return reason
    }
    clearVerdict(cacheDir, device)
    return enc
  } catch (err) {
    await release(enc)
    const reason = errText(err)
    rememberVerdict(cacheDir, device, 'error', reason, runtimeVersion())
    return reason
  }
}

async function load(onProgress: Progress): Promise<Engine> {
  if (!cacheDir) throw new Error('pasta de cache dos modelos não configurada')
  const dir = await ensureParakeetFiles(cacheDir, onProgress)
  onProgress({ phase: 'load', model: PARAKEET_MODEL })
  const path = (f: { name: string }): string => join(dir, f.name)
  const vocab = parseVocab(readFileSync(path(PARAKEET_FILES.vocab), 'utf8'))
  const [pre, dec] = await Promise.all([create(path(PARAKEET_FILES.preprocessor), 'cpu'), create(path(PARAKEET_FILES.decoderJoint), 'cpu')])
  try {
    const encPath = path(PARAKEET_FILES.encoder)
    const device = gpuDeviceFor(ort.listSupportedBackends().map((b) => b.name))
    let gpuError = gpuBroken ?? (device ? activeVerdict(cacheDir, device, runtimeVersion()) : undefined)
    if (device && !gpuError) {
      const got = await tryGpu({ pre, dec, vocab }, encPath, device)
      if (typeof got !== 'string') {
        log(`Parakeet: encoder na ${deviceLabel(device)}, decoder na CPU`)
        return { pre, enc: got, dec, vocab, device }
      }
      gpuError = got
      gpuBroken = got
    }
    if (gpuError) log(`Parakeet: GPU descartada (${gpuError}); usando a CPU`)
    const enc = await create(encPath, 'cpu')
    if (!gpuError) log('Parakeet na CPU')
    return { pre, enc, dec, vocab, device: 'cpu', ...(gpuError ? { gpuError } : {}) }
  } catch (err) {
    await release(pre, dec)
    throw err
  }
}

export function loadParakeet(onProgress: Progress): Promise<Engine> {
  if (!engine) {
    const loading = load(onProgress)
    engine = loading
    loading.catch(() => {
      if (engine === loading) engine = null
    })
  }
  return engine
}

export function stateOf(e: Engine): SttState {
  return { device: e.device, ...(e.gpuError ? { gpuError: e.gpuError } : {}) }
}

export async function transcribe(pcm16k: Float32Array, onProgress: Progress): Promise<{ text: string } & SttState> {
  let e = await loadParakeet(onProgress)
  onProgress({ phase: 'transcribe', progress: 0 })
  let text: string
  try {
    text = await run(e, pcm16k, onProgress)
  } catch (err) {
    if (e.device === 'cpu') throw err
    // Failed while running on the GPU: this worker won't try it again, and the
    // next launches won't either until the verdict expires (gpuVerdict.ts).
    gpuBroken = `falhou ao transcrever: ${errText(err)}`
    rememberVerdict(cacheDir, e.device, 'error', gpuBroken, runtimeVersion())
    engine = null
    await release(e.pre, e.enc, e.dec)
    e = await loadParakeet(onProgress)
    text = await run(e, pcm16k, onProgress)
  }
  onProgress({ phase: 'transcribe', progress: 1 })
  return { text, ...stateOf(e) }
}
