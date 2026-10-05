/**
 * Local voice engine — speech in and out with no cloud service.
 *
 *   TTS: Kokoro-82M (fp32, CPU) with pt-BR phonemes from eSpeak NG (WASM).
 *   STT: NVIDIA Parakeet TDT 0.6B v3 (int8 ONNX) on onnxruntime-node; encoder
 *        on the GPU (CUDA / DirectML) when it works, else everything on the CPU.
 *
 * All inference runs in a separate process (Electron utilityProcess; a
 * worker_threads Worker when running under plain Node), so the main process's
 * event loop never blocks on it. Models download on first use into the folder
 * given to setVoiceCacheDir(); later runs work offline.
 *
 * API
 * ---
 * setVoiceCacheDir(dir)
 *   Must be called before anything else (e.g. `join(getCacheInfo().localDir,
 *   'voice-models')`). Changing it later only affects future downloads.
 *
 * synthesizeLocal(text, { voice?, speed? }, onProgress?)
 *     => Promise<{ base64, mimeType: 'audio/wav', durationSec, chunks }>
 *   Speaks pt-BR `text` as a 24 kHz mono PCM16 WAV (base64). `voice` is one of
 *   LOCAL_VOICES (default 'pf_dora'); `speed` is Kokoro's native rate factor
 *   (0.5–2, default 1). Long text is split by sentence and the audio joined,
 *   so nothing is truncated at Kokoro's 510-token context.
 *
 * transcribeSpeech(audioBase64, mimeType, onProgress?) => Promise<string>
 *   Transcription (the language — Portuguese included — is detected from the
 *   audio). Accepts WAV (desktop recorder) and WebM/Ogg Opus (phone
 *   MediaRecorder), decoded in the worker with WASM — no ffmpeg. Inside
 *   Electron, other formats (mp4/AAC, mp3) fall back to Chromium's decoder.
 *   Long audio is transcribed in ~20 s windows cut at pauses (chunking.ts).
 *
 * prepareVoiceModels(what: 'tts' | 'stt', onProgress?) => Promise<void>
 *   Downloads/loads the models ahead of time so the first real call is fast.
 *
 * getSttStatus()
 *   Where the transcription model last ran: { device: 'cuda' | 'dml' | 'cpu' |
 *   null, label, gpuError? } (null = not loaded in this worker yet).
 *
 *   Env (read by the worker at spawn): AGENT_CODE_VOICE_DEVICE=cpu|gpu,
 *   AGENT_CODE_VOICE_THREADS=N, AGENT_CODE_VOICE_GPU_BUDGET_SEC=N.
 *
 * stopVoiceEngine() => Promise<void>
 *   Kills the worker (frees the models' memory); in-flight calls reject.
 *   The next call starts it again. Call it on app quit.
 *
 * onProgress receives VoiceProgress: { phase: 'download' | 'load' | 'ready' |
 *   'synthesize' | 'decode' | 'transcribe', model?, file?, progress? (0..1),
 *   loaded?, total? } — download events carry bytes for a progress bar.
 */
import { canDecodeWithChromium, decodeWithChromium } from './chromiumDecode'
import { request, setCacheDir, stop, VoiceWorkerError } from './host'
import {
  deviceLabel,
  KOKORO_VOICES,
  PARAKEET_MODEL,
  type KokoroVoice,
  type SttDevice,
  type SttState,
  type SynthesisResult,
  type TranscribeResult,
  type VoiceProgress
} from './protocol'

export { deviceLabel, KOKORO_VOICES as LOCAL_VOICES, PARAKEET_MODEL, VoiceWorkerError }
export { kokoroInstalled, parakeetInstalled, voiceModelsInstalled } from './installed'
export { PARAKEET_DOWNLOAD_BYTES } from './parakeetFiles'
export type { KokoroVoice as LocalVoice, SttDevice, SttState, SynthesisResult, VoiceProgress }

const MAX_TEXT_CHARS = 20_000
const MAX_AUDIO_BYTES = 50 * 1024 * 1024

/** Where the worker last reported the model running (null = not loaded yet). */
let lastState: SttState | null = null

function remember(r: TranscribeResult): void {
  if (r.device) lastState = { device: r.device, ...(r.gpuError ? { gpuError: r.gpuError } : {}) }
}

/** `label` is for people: 'GPU (DirectML)' / 'GPU (CUDA)' / 'CPU'. */
export function getSttStatus(): { device: SttDevice | null; label: string | null; gpuError?: string } {
  const s = lastState
  return { device: s?.device ?? null, label: s ? deviceLabel(s.device) : null, ...(s?.gpuError ? { gpuError: s.gpuError } : {}) }
}

export function setVoiceCacheDir(dir: string): void {
  if (typeof dir !== 'string' || !dir.trim()) throw new TypeError('setVoiceCacheDir: pasta inválida')
  setCacheDir(dir)
}

export async function synthesizeLocal(
  text: string,
  opts: { voice?: string; speed?: number } = {},
  onProgress?: (p: VoiceProgress) => void
): Promise<SynthesisResult> {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('synthesizeLocal: texto vazio')
  if (text.length > MAX_TEXT_CHARS) throw new RangeError(`synthesizeLocal: texto acima de ${MAX_TEXT_CHARS} caracteres`)
  const voice = (opts.voice ?? 'pf_dora') as KokoroVoice
  if (!KOKORO_VOICES.includes(voice)) throw new RangeError(`synthesizeLocal: voz desconhecida "${opts.voice}"`)
  const speed = opts.speed ?? 1
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new RangeError('synthesizeLocal: speed fora de 0.5–2')
  return (await request({ op: 'synthesize', text, voice, speed }, onProgress)) as SynthesisResult
}

export async function transcribeSpeech(audioBase64: string, mimeType: string, onProgress?: (p: VoiceProgress) => void): Promise<string> {
  if (typeof audioBase64 !== 'string' || !audioBase64) throw new TypeError('transcribeSpeech: áudio vazio')
  const b64 = audioBase64.replace(/^data:[^,]*,/, '') // tolerate a data: URL
  const audio = new Uint8Array(Buffer.from(b64, 'base64'))
  if (audio.length === 0) throw new TypeError('transcribeSpeech: áudio vazio')
  if (audio.length > MAX_AUDIO_BYTES) throw new RangeError('transcribeSpeech: áudio acima de 50 MB')
  const mime = typeof mimeType === 'string' ? mimeType : ''
  let r: TranscribeResult
  try {
    r = (await request({ op: 'transcribe', audio, mimeType: mime }, onProgress)) as TranscribeResult
  } catch (err) {
    if (!(err instanceof VoiceWorkerError && err.code === 'UNSUPPORTED_AUDIO' && canDecodeWithChromium())) throw err
    onProgress?.({ phase: 'decode' })
    const pcm = await decodeWithChromium(audio)
    r = (await request({ op: 'transcribe', pcm }, onProgress)) as TranscribeResult
  }
  remember(r)
  return r.text
}

export async function prepareVoiceModels(what: 'tts' | 'stt', onProgress?: (p: VoiceProgress) => void): Promise<void> {
  if (what !== 'tts' && what !== 'stt') throw new RangeError('prepareVoiceModels: use "tts" ou "stt"')
  const r = await request({ op: 'prepare', what }, onProgress)
  if (what === 'stt') remember(r as TranscribeResult)
}

export function stopVoiceEngine(): Promise<void> {
  lastState = null
  return stop()
}
