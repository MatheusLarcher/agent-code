/**
 * Model loading and inference — runs ONLY inside the voice worker.
 *
 * Kokoro-82M (fp32, CPU) for pt-BR speech here; Whisper (GPU/CPU) in
 * whisper.ts. Both go through @huggingface/transformers + onnxruntime-node. Files are downloaded on
 * first use into `env.cacheDir` (the app's cache folder, set by the host),
 * never into node_modules.
 */
import { existsSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { AutoTokenizer, env, StyleTextToSpeech2Model, type ProgressInfo } from '@huggingface/transformers'
import { KokoroTTS, type GenerateOptions } from 'kokoro-js'
import { loadEspeakPtBr, phonemizeWith } from './phonemize'
import { concatSamples, withNoiseFloor } from './pcm'
import { planKokoroChunks } from './textChunks'
import type { KokoroVoice, VoiceProgress } from './protocol'

export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'
export const KOKORO_SAMPLE_RATE = 24000
/** Silence between synthesized sentences (Kokoro already pauses at the period). */
const SENTENCE_GAP_SAMPLES = Math.round(0.08 * KOKORO_SAMPLE_RATE)
/** Extra noise-floor lead-in so an idle output device is awake before the
 *  first syllable (on top of Kokoro's own ~180 ms opening). See pcm.noiseFloor. */
const LEAD_IN_SAMPLES = Math.round(0.2 * KOKORO_SAMPLE_RATE)

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
export function relay(onProgress: Progress, model: string): (p: ProgressInfo) => void {
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
  return { samples: withNoiseFloor(concatSamples(parts, SENTENCE_GAP_SAMPLES), LEAD_IN_SAMPLES), chunks: chunks.length }
}

