/**
 * Model loading and inference — runs ONLY inside the voice worker.
 *
 * Kokoro-82M (fp32, CPU) for pt-BR speech and Whisper for transcription, both
 * through @huggingface/transformers + onnxruntime-node. Files are downloaded on
 * first use into `env.cacheDir` (the app's cache folder, set by the host),
 * never into node_modules.
 */
import { existsSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { AutoTokenizer, env, pipeline, StyleTextToSpeech2Model, type ProgressInfo } from '@huggingface/transformers'
import { KokoroTTS, type GenerateOptions } from 'kokoro-js'
import { loadEspeakPtBr, phonemizeWith } from './phonemize'
import { concatSamples } from './pcm'
import { planKokoroChunks } from './textChunks'
import { WHISPER_PROFILES, type KokoroVoice, type VoiceProgress, type WhisperProfile } from './protocol'

export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'
export const KOKORO_SAMPLE_RATE = 24000
/** Silence between synthesized sentences (Kokoro already pauses at the period). */
const SENTENCE_GAP_SAMPLES = Math.round(0.08 * KOKORO_SAMPLE_RATE)

export type Progress = (p: VoiceProgress) => void

export function configureCache(cacheDir: string): void {
  env.cacheDir = cacheDir
  env.useFSCache = true
  env.allowRemoteModels = true
  env.allowLocalModels = false // never look for models inside node_modules
}

/**
 * ONNX Runtime threads. Its default (one per physical core) spreads work over
 * the E-cores of hybrid Intel CPUs and the stragglers slow every step; a
 * smaller pool measured faster (scripts/voice/bench-whisper.mjs). Override
 * with AGENT_CODE_VOICE_THREADS (0 = leave it to ONNX Runtime).
 */
export function sessionOptions(): { intraOpNumThreads?: number; interOpNumThreads?: number } {
  const raw = process.env.AGENT_CODE_VOICE_THREADS
  const forced = raw === undefined || raw === '' ? NaN : Number(raw)
  if (forced === 0) return {}
  const threads = Number.isInteger(forced) && forced > 0 ? forced : Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)))
  return { intraOpNumThreads: threads, interOpNumThreads: 1 }
}

/** transformers announces 'download' and streams byte progress for cache
 *  reads too; a file already in the cache folder is reported as 'load'. */
function relay(onProgress: Progress, model: string): (p: ProgressInfo) => void {
  const cached = new Map<string, boolean>()
  const isCached = (file: string): boolean => {
    if (!cached.has(file)) cached.set(file, existsSync(join(env.cacheDir ?? '', model, file)))
    return cached.get(file)!
  }
  return (p) => {
    if (p.status === 'progress') {
      const phase = isCached(p.file) ? 'load' : 'download'
      onProgress({ phase, model, file: p.file, progress: p.progress / 100, loaded: p.loaded, total: p.total })
    } else if (p.status === 'initiate') {
      onProgress({ phase: isCached(p.file) ? 'load' : 'download', model, file: p.file })
    } else if (p.status === 'ready') {
      onProgress({ phase: 'ready', model })
    }
  }
}

// ------------------------------------------------------------------ Kokoro

let kokoro: Promise<KokoroTTS> | null = null

export function loadKokoro(onProgress: Progress): Promise<KokoroTTS> {
  // What KokoroTTS.from_pretrained does, plus session_options (it has no such knob).
  kokoro ??= (async () => {
    const progress_callback = relay(onProgress, KOKORO_MODEL)
    const [model, tokenizer] = await Promise.all([
      StyleTextToSpeech2Model.from_pretrained(KOKORO_MODEL, { dtype: 'fp32', device: 'cpu', session_options: sessionOptions(), progress_callback }),
      AutoTokenizer.from_pretrained(KOKORO_MODEL, { progress_callback })
    ])
    return new KokoroTTS(model as never, tokenizer)
  })()
  kokoro.catch(() => {
    kokoro = null
  })
  return kokoro
}

export async function synthesize(
  text: string,
  voice: KokoroVoice,
  speed: number,
  onProgress: Progress
): Promise<{ samples: Float32Array; chunks: number }> {
  const [tts, convert] = await Promise.all([loadKokoro(onProgress), loadEspeakPtBr()])
  const chunks = await planKokoroChunks(text, (piece) => phonemizeWith(piece, convert))
  const parts: Float32Array[] = []
  for (let i = 0; i < chunks.length; i++) {
    onProgress({ phase: 'synthesize', progress: i / chunks.length })
    const { input_ids } = tts.tokenizer(chunks[i], { truncation: true })
    // generate_from_ids skips _validate_voice (which only accepts en voices)
    // and reads voices/<voice>.bin shipped inside kokoro-js.
    const audio = await tts.generate_from_ids(input_ids, { voice: voice as GenerateOptions['voice'], speed })
    parts.push(audio.audio)
  }
  onProgress({ phase: 'synthesize', progress: 1 })
  return { samples: concatSamples(parts, SENTENCE_GAP_SAMPLES), chunks: chunks.length }
}

// ----------------------------------------------------------------- Whisper

type Asr = ((audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>) & {
  dispose?: () => Promise<unknown>
}
let whisper: { profile: WhisperProfile; asr: Promise<Asr> } | null = null

export function loadWhisper(profile: WhisperProfile, onProgress: Progress): Promise<Asr> {
  if (whisper?.profile !== profile) {
    const spec = WHISPER_PROFILES[profile]
    if (!spec) return Promise.reject(new Error(`perfil Whisper desconhecido: ${profile}`))
    const previous = whisper
    const asr = (async () => {
      // One Whisper at a time: release the old sessions before loading another.
      await (await previous?.asr.catch(() => null))?.dispose?.()
      return (await pipeline('automatic-speech-recognition', spec.model, {
        dtype: spec.dtype as never,
        device: 'cpu',
        session_options: sessionOptions(),
        progress_callback: relay(onProgress, spec.model)
      })) as unknown as Asr
    })()
    whisper = { profile, asr }
    asr.catch(() => {
      if (whisper?.asr === asr) whisper = null
    })
  }
  return whisper!.asr
}

export async function transcribe(pcm16k: Float32Array, profile: WhisperProfile, onProgress: Progress): Promise<string> {
  const asr = await loadWhisper(profile, onProgress)
  onProgress({ phase: 'transcribe', progress: 0 })
  const long = pcm16k.length > 30 * 16000
  const out = await asr(pcm16k, {
    language: 'portuguese',
    task: 'transcribe',
    ...(long ? { chunk_length_s: 30, stride_length_s: 5 } : {})
  })
  onProgress({ phase: 'transcribe', progress: 1 })
  const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text
  return text.replace(/\s+/g, ' ').trim()
}
