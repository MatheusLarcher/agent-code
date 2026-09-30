/** Messages between the voice host (main process) and the voice worker. */

export const KOKORO_VOICES = ['pf_dora', 'pm_alex', 'pm_santa'] as const
export type KokoroVoice = (typeof KOKORO_VOICES)[number]

type Dtype = 'fp32' | 'fp16' | 'q8' | 'q4'
/**
 * Whisper model + ONNX precision per profile. The default is picked by
 * scripts/voice/bench-whisper.mjs (see WHISPER_PROFILE in index.ts).
 */
export const WHISPER_PROFILES = {
  'small-fp32': { model: 'onnx-community/whisper-small', dtype: 'fp32' },
  'small-q8': { model: 'onnx-community/whisper-small', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } },
  'turbo-q8': { model: 'onnx-community/whisper-large-v3-turbo', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } },
  'turbo-q4': { model: 'onnx-community/whisper-large-v3-turbo', dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' } }
} as const satisfies Record<string, { model: string; dtype: Dtype | Record<string, Dtype> }>
export type WhisperProfile = keyof typeof WHISPER_PROFILES

export interface VoiceProgress {
  /** download/load = model files; synthesize/transcribe = the work itself. */
  phase: 'download' | 'load' | 'ready' | 'synthesize' | 'decode' | 'transcribe'
  model?: string
  file?: string
  /** 0..1 when known. */
  progress?: number
  loaded?: number
  total?: number
}

export type WorkerRequest =
  | { id: number; op: 'config'; cacheDir: string }
  | { id: number; op: 'prepare'; what: 'tts' | 'stt'; profile: WhisperProfile }
  | { id: number; op: 'synthesize'; text: string; voice: KokoroVoice; speed: number }
  | { id: number; op: 'transcribe'; profile: WhisperProfile; audio?: Uint8Array; pcm?: Float32Array; mimeType?: string }

export interface SynthesisResult {
  base64: string
  mimeType: 'audio/wav'
  durationSec: number
  chunks: number
}

export type WorkerResponse =
  | { id: number; type: 'progress'; progress: VoiceProgress }
  | { id: number; type: 'result'; result: unknown }
  | { id: number; type: 'error'; message: string; code?: string }
