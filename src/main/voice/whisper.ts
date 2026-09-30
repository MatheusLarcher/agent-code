/**
 * Whisper inside the voice worker: GPU first, CPU when the GPU can't help.
 *
 * GPU = the ENCODER on DirectML (Windows) or CUDA (Linux x64), the decoder on
 * the CPU (see WhisperSpec.gpuEncoder for why). Any of these sends the profile
 * to the CPU, silently for the user and logged for us:
 *   - the GPU session fails to be created (no DirectML/CUDA, driver error);
 *   - the warm-up run fails or is slower than WARMUP_BUDGET_SEC (an integrated
 *     GPU picked as adapter 0 is ~20x slower than the CPU) — remembered in
 *     `whisper-gpu.json` in the model folder so later launches skip it;
 *   - a real transcription fails on the GPU (retried on the CPU at once).
 * Env: AGENT_CODE_VOICE_DEVICE=cpu forces the CPU; =gpu skips the speed guard;
 * AGENT_CODE_VOICE_GPU_BUDGET_SEC overrides WARMUP_BUDGET_SEC.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env, pipeline } from '@huggingface/transformers'
import { relay, sessionOptions, type Progress } from './models'
import { deviceLabel, gpuDeviceFor, WHISPER_PROFILES, type WhisperDevice, type WhisperProfile, type WhisperSpec, type WhisperState } from './protocol'

/** Slowest acceptable warm-up (1 s of silence: one encoder pass + a few decoder
 *  steps — the encoder always sees a 30 s window). On the dev machine: 0.8 s
 *  (turbo) / 0.7 s (small) on the RTX 5050 via DirectML, while the Intel UHD
 *  next to it (DirectML adapter 1) took ~27 s for a 5 s clip; the CPU does the
 *  whole 5 s clip in ~4.5 s (turbo). */
const WARMUP_BUDGET_SEC = 4
const VERDICT_FILE = 'whisper-gpu.json'

type Asr = ((audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>) & {
  dispose?: () => Promise<unknown>
}
interface Loaded {
  asr: Asr
  device: WhisperDevice
  gpuError?: string
}

let whisper: { profile: WhisperProfile; loaded: Promise<Loaded> } | null = null
/** Profiles whose GPU path already failed in this worker. */
const gpuBroken = new Map<WhisperProfile, string>()

const log = (msg: string): void => console.log(`[voice] ${msg}`)
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 300)

function verdictPath(): string | null {
  return env.cacheDir ? join(env.cacheDir, VERDICT_FILE) : null
}

function readVerdicts(): Record<string, string> {
  const file = verdictPath()
  if (!file || !existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function rememberSlowGpu(profile: WhisperProfile, reason: string): void {
  const file = verdictPath()
  if (!file) return
  try {
    writeFileSync(file, JSON.stringify({ ...readVerdicts(), [profile]: reason }, null, 2))
  } catch {
    /* a read-only cache only costs the warm-up again next launch */
  }
}

async function create(spec: WhisperSpec, device: WhisperDevice, onProgress: Progress): Promise<Asr> {
  const gpu = device !== 'cpu' && spec.gpuEncoder
  return (await pipeline('automatic-speech-recognition', spec.model, {
    dtype: (gpu ? { ...spec.dtype, encoder_model: spec.gpuEncoder } : spec.dtype) as never,
    device: (gpu ? { encoder_model: device, decoder_model_merged: 'cpu' } : 'cpu') as never,
    session_options: sessionOptions(),
    progress_callback: relay(onProgress, spec.model)
  })) as unknown as Asr
}

/** GPU session that ran a warm-up fast enough, or the reason it didn't. */
async function tryGpu(profile: WhisperProfile, spec: WhisperSpec, device: Exclude<WhisperDevice, 'cpu'>, onProgress: Progress): Promise<Asr | string> {
  let asr: Asr | null = null
  try {
    asr = await create(spec, device, onProgress)
    const t = performance.now()
    await asr(new Float32Array(16000), { language: 'portuguese', task: 'transcribe' })
    const sec = (performance.now() - t) / 1000
    log(`Whisper ${profile}: aquecimento na ${deviceLabel(device)} em ${sec.toFixed(2)} s`)
    const budget = Number(process.env.AGENT_CODE_VOICE_GPU_BUDGET_SEC) || WARMUP_BUDGET_SEC
    if (sec > budget && process.env.AGENT_CODE_VOICE_DEVICE !== 'gpu') {
      const reason = `aquecimento em ${sec.toFixed(1)} s na ${deviceLabel(device)} (limite ${budget} s)`
      rememberSlowGpu(profile, reason)
      await asr.dispose?.()
      return reason
    }
    return asr
  } catch (err) {
    await asr?.dispose?.().catch(() => undefined)
    return errText(err)
  }
}

async function load(profile: WhisperProfile, onProgress: Progress): Promise<Loaded> {
  const spec: WhisperSpec = WHISPER_PROFILES[profile]
  const device = spec.gpuEncoder ? gpuDeviceFor() : null
  let gpuError = gpuBroken.get(profile) ?? readVerdicts()[profile]
  if (device && !gpuError) {
    const got = await tryGpu(profile, spec, device, onProgress)
    if (typeof got !== 'string') {
      log(`Whisper ${profile} na ${deviceLabel(device)} (encoder ${spec.gpuEncoder}, decoder ${spec.dtype.decoder_model_merged} na CPU)`)
      return { asr: got, device }
    }
    gpuError = got
    gpuBroken.set(profile, got)
  }
  if (gpuError) log(`Whisper ${profile}: GPU descartada (${gpuError}); usando a CPU`)
  const asr = await create(spec, 'cpu', onProgress)
  if (!gpuError) log(`Whisper ${profile} na CPU`)
  return { asr, device: 'cpu', gpuError }
}

export function loadWhisper(profile: WhisperProfile, onProgress: Progress): Promise<Loaded> {
  if (whisper?.profile !== profile) {
    if (!Object.hasOwn(WHISPER_PROFILES, profile)) return Promise.reject(new Error(`perfil Whisper desconhecido: ${profile}`))
    const previous = whisper
    const loaded = (async () => {
      // One Whisper at a time: release the old sessions before loading another.
      await (await previous?.loaded.catch(() => null))?.asr.dispose?.()
      return load(profile, onProgress)
    })()
    whisper = { profile, loaded }
    loaded.catch(() => {
      if (whisper?.loaded === loaded) whisper = null
    })
  }
  return whisper!.loaded
}

export function stateOf(profile: WhisperProfile, l: Loaded): WhisperState {
  return { profile, device: l.device, ...(l.gpuError ? { gpuError: l.gpuError } : {}) }
}

async function run(asr: Asr, pcm16k: Float32Array): Promise<string> {
  const long = pcm16k.length > 30 * 16000
  const out = await asr(pcm16k, {
    language: 'portuguese',
    task: 'transcribe',
    ...(long ? { chunk_length_s: 30, stride_length_s: 5 } : {})
  })
  const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text
  return text.replace(/\s+/g, ' ').trim()
}

export async function transcribe(
  pcm16k: Float32Array,
  profile: WhisperProfile,
  onProgress: Progress
): Promise<{ text: string } & WhisperState> {
  let loaded = await loadWhisper(profile, onProgress)
  onProgress({ phase: 'transcribe', progress: 0 })
  let text: string
  try {
    text = await run(loaded.asr, pcm16k)
  } catch (err) {
    if (loaded.device === 'cpu') throw err
    // Failed while running on the GPU: this worker won't try it again.
    const reason = `falhou ao transcrever: ${errText(err)}`
    gpuBroken.set(profile, reason)
    if (whisper?.profile === profile) whisper = null
    await loaded.asr.dispose?.().catch(() => undefined)
    loaded = await loadWhisper(profile, onProgress)
    text = await run(loaded.asr, pcm16k)
  }
  onProgress({ phase: 'transcribe', progress: 1 })
  return { text, ...stateOf(profile, loaded) }
}
