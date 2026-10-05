/** Messages between the voice host (main process) and the voice worker. */

/** Hugging Face repo of the Kokoro model (the worker loads it; installed.ts checks its files). */
export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'
export const KOKORO_VOICES =['pf_dora', 'pm_alex', 'pm_santa'] as const
export type KokoroVoice = (typeof KOKORO_VOICES)[number]

/**
 * NVIDIA Parakeet TDT 0.6B v3 exported to ONNX by istupakov (the onnx-asr
 * project), int8. 25 languages; the language (Portuguese included) is detected
 * from the audio — there is no language prompt. Pinned to one revision and
 * checked by sha256, so a changed upload can never be loaded silently.
 *   nemo128.onnx    waveform → 128 log-mel features (NeMo's preprocessor)
 *   encoder         features → encoder frames (one per 80 ms)
 *   decoder_joint   prediction net + joint: token logits ++ TDT duration logits
 */
export const PARAKEET_MODEL = 'istupakov/parakeet-tdt-0.6b-v3-onnx'
export const PARAKEET_REVISION = '8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce'
export interface ModelFile {
  name: string
  size: number
  /** sha256 of the file (Git LFS oid); absent for small text files. */
  sha256?: string
}
export const PARAKEET_FILES = {
  config: { name: 'config.json', size: 97 },
  vocab: { name: 'vocab.txt', size: 93939 },
  preprocessor: {
    name: 'nemo128.onnx',
    size: 139764,
    sha256: 'a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f'
  },
  encoder: {
    name: 'encoder-model.int8.onnx',
    size: 652183999,
    sha256: '6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09'
  },
  decoderJoint: {
    name: 'decoder_joint-model.int8.onnx',
    size: 18202004,
    sha256: 'eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70'
  }
} as const satisfies Record<string, ModelFile>

/** Where the transcription model actually runs: 'cuda' (CUDA EP), 'dml'
 *  (DirectML, Windows — also NVIDIA cards) or 'cpu'. */
export type SttDevice = 'cuda' | 'dml' | 'cpu'

/**
 * The GPU execution provider to try, or null. Picks from what this
 * onnxruntime-node build reports (listSupportedBackends): CUDA when present
 * (Linux x64 with the CUDA EP installed), else DirectML (the Windows build —
 * which has no CUDA EP as of 1.21), else none.
 */
export function gpuDeviceFor(
  supported: readonly string[],
  pref: string | undefined = process.env.AGENT_CODE_VOICE_DEVICE
): Exclude<SttDevice, 'cpu'> | null {
  if (pref === 'cpu') return null
  if (supported.includes('cuda')) return 'cuda'
  if (supported.includes('dml')) return 'dml'
  return null
}

export function deviceLabel(device: SttDevice): string {
  return device === 'dml' ? 'GPU (DirectML)' : device === 'cuda' ? 'GPU (CUDA)' : 'CPU'
}
/** What the worker reports after loading/transcribing. */
export interface SttState {
  device: SttDevice
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
  | { id: number; op: 'prepare'; what: 'tts' | 'stt' }
  | { id: number; op: 'synthesize'; text: string; voice: KokoroVoice; speed: number }
  | { id: number; op: 'transcribe'; audio?: Uint8Array; pcm?: Float32Array; mimeType?: string }

/** Result of 'transcribe' (text) and of 'prepare' for 'stt' (text = ''). */
export interface TranscribeResult extends Partial<SttState> {
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
