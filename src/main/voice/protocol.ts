/** Messages between the voice host (main process) and the voice worker. */

/** Hugging Face repo of the Kokoro model (the worker loads it; installed.ts checks its files). */
export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'
export const KOKORO_VOICES =['pf_dora', 'pm_alex', 'pm_santa'] as const
export type KokoroVoice = (typeof KOKORO_VOICES)[number]

export type Dtype = 'fp32' | 'fp16' | 'q8' | 'q4'
export interface WhisperSpec {
  model: string
  /** Precision of each file on the CPU. */
  dtype: { encoder_model: Dtype; decoder_model_merged: Dtype }
  /**
   * Encoder precision on the GPU; absent = CPU only. Only the ENCODER goes to
   * the GPU: under DirectML the merged decoder (its `If` node + KV cache) runs
   * but emits no tokens in any precision (q8/fp16/fp32), and the q8 encoder
   * (MatMulInteger/DynamicQuantizeLinear) is slower there than fp16.
   * Reproduce with scripts/voice/probe-gpu.mjs; latency by
   * scripts/voice/bench-whisper.mjs --devices gpu,cpu.
   */
  gpuEncoder?: Dtype
}
/**
 * Whisper model + ONNX precision per profile. The default is picked by
 * scripts/voice/bench-whisper.mjs (see WHISPER_PROFILE in index.ts).
 */
export const WHISPER_PROFILES = {
  'small-fp32': {
    model: 'onnx-community/whisper-small',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
    gpuEncoder: 'fp32'
  },
  'small-q8': { model: 'onnx-community/whisper-small', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } },
  'turbo-q8': {
    model: 'onnx-community/whisper-large-v3-turbo',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    gpuEncoder: 'fp16'
  },
  'turbo-q4': { model: 'onnx-community/whisper-large-v3-turbo', dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' } }
} as const satisfies Record<string, WhisperSpec>
export type WhisperProfile = keyof typeof WHISPER_PROFILES

/** Where Whisper's encoder actually runs: 'dml' (DirectML, Windows), 'cuda'
 *  (Linux x64 with the CUDA EP installed) or 'cpu'. */
export type WhisperDevice = 'dml' | 'cuda' | 'cpu'

/** The GPU execution provider onnxruntime-node can try here, or null. Its
 *  Windows build ships DirectML; on Linux x64 CUDA needs the CUDA EP installed
 *  (else the session fails and the CPU takes over). */
export function gpuDeviceFor(
  platform: string = process.platform,
  arch: string = process.arch,
  pref: string | undefined = process.env.AGENT_CODE_VOICE_DEVICE
): Exclude<WhisperDevice, 'cpu'> | null {
  if (pref === 'cpu') return null
  if (platform === 'win32') return 'dml'
  if (platform === 'linux' && arch === 'x64') return 'cuda'
  return null
}

export function deviceLabel(device: WhisperDevice): string {
  return device === 'dml' ? 'GPU (DirectML)' : device === 'cuda' ? 'GPU (CUDA)' : 'CPU'
}
/** What the worker reports after loading/transcribing. */
export interface WhisperState {
  profile: WhisperProfile
  device: WhisperDevice
  /** Why a GPU attempt was abandoned, when it was. */
  gpuError?: string
}

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

/** Result of 'transcribe' (text) and of 'prepare' for 'stt' (text = ''). */
export interface TranscribeResult extends Partial<WhisperState> {
  text: string
}

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
