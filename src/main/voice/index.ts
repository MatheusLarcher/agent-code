/**
 * Local voice engine — speech in and out with no cloud service.
 *
 *   TTS: Kokoro-82M (fp32, CPU) with pt-BR phonemes from eSpeak NG (WASM).
 *   STT: Whisper via @huggingface/transformers (onnxruntime-node); encoder on
 *        the GPU (DirectML / CUDA) when it works, else everything on the CPU.
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
 * transcribeWhisper(audioBase64, mimeType, onProgress?, profile?) => Promise<string>
 *   Portuguese transcription. Accepts WAV (desktop recorder) and WebM/Ogg Opus
 *   (phone MediaRecorder), decoded in the worker with WASM — no ffmpeg. Inside
 *   Electron, other formats (mp4/AAC, mp3) fall back to Chromium's decoder.
 *
 * prepareVoiceModels(what: 'tts' | 'stt', onProgress?, profile?) => Promise<void>
 *   Downloads/loads the models ahead of time so the first real call is fast.
 *   `profile` (both functions) defaults to the one set by setWhisperProfile.
 *
 * setWhisperProfile(profile) / getWhisperStatus()
 *   Picks the Whisper profile for the next calls (default WHISPER_PROFILE,
 *   'turbo-q8'; 'small-fp32' is the light one) — the worker swaps models on
 *   the next call, no restart. The status says where it last ran:
 *   { profile, device: 'dml' | 'cuda' | 'cpu' | null, label, gpuError? }.
 *
 *   Env (read by the worker at spawn): AGENT_CODE_VOICE_DEVICE=cpu|gpu,
 *   AGENT_CODE_VOICE_THREADS=N.
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
  WHISPER_PROFILES,
  type KokoroVoice,
  type SynthesisResult,
  type TranscribeResult,
  type VoiceProgress,
  type WhisperDevice,
  type WhisperProfile,
  type WhisperState
} from './protocol'

export { deviceLabel, KOKORO_VOICES as LOCAL_VOICES, WHISPER_PROFILES, VoiceWorkerError }
export { kokoroInstalled, voiceModelsInstalled, whisperInstalled } from './installed'
export type { KokoroVoice as LocalVoice, SynthesisResult, VoiceProgress, WhisperDevice, WhisperProfile, WhisperState }

/**
 * large-v3-turbo: the best Whisper for pt-BR that fits the latency budget once
 * its encoder runs on the GPU. Measured by scripts/voice/bench-whisper.mjs on
 * the dev machine (i7-14650HX + RTX 5050 Laptop, 8 ORT threads), median for
 * 5 s / 13 s of speech, WER 0% everywhere (also at 5 dB SNR): turbo-q8 GPU
 * (DirectML: encoder fp16, decoder q8 on the CPU) 1.64 / 3.40 s, CPU (q8)
 * 3.47 / 6.35 s — the CPU fallback is slower but correct. small-fp32 stays as
 * the lighter choice: GPU 1.05 / 2.30 s, CPU 1.87 / 3.18 s.
 */
export const WHISPER_PROFILE: WhisperProfile = 'turbo-q8'

const MAX_TEXT_CHARS = 20_000
const MAX_AUDIO_BYTES = 50 * 1024 * 1024

let whisperProfile: WhisperProfile = WHISPER_PROFILE
/** Last device the worker reported for each profile (null = not loaded yet). */
const lastState = new Map<WhisperProfile, WhisperState>()

function remember(r: TranscribeResult): void {
  if (r.profile && r.device) {
    lastState.set(r.profile, { profile: r.profile, device: r.device, ...(r.gpuError ? { gpuError: r.gpuError } : {}) })
  }
}

/** Current profile and where it ran the last time (device null = not loaded
 *  yet in this worker). `label` is for people: 'GPU (DirectML)' / 'CPU'. */
export function getWhisperStatus(): { profile: WhisperProfile; device: WhisperDevice | null; label: string | null; gpuError?: string } {
  const s = lastState.get(whisperProfile)
  return { profile: whisperProfile, device: s?.device ?? null, label: s ? deviceLabel(s.device) : null, ...(s?.gpuError ? { gpuError: s.gpuError } : {}) }
}

export function setVoiceCacheDir(dir: string): void {
  if (typeof dir !== 'string' || !dir.trim()) throw new TypeError('setVoiceCacheDir: pasta inválida')
  setCacheDir(dir)
}

/** Override the Whisper profile (benchmarks, or a lighter model on slow machines). */
export function setWhisperProfile(profile: WhisperProfile): void {
  if (!Object.hasOwn(WHISPER_PROFILES, profile)) throw new RangeError(`perfil Whisper desconhecido "${profile}"`)
  whisperProfile = profile
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

export async function transcribeWhisper(
  audioBase64: string,
  mimeType: string,
  onProgress?: (p: VoiceProgress) => void,
  profile: WhisperProfile = whisperProfile
): Promise<string> {
  if (typeof audioBase64 !== 'string' || !audioBase64) throw new TypeError('transcribeWhisper: áudio vazio')
  const b64 = audioBase64.replace(/^data:[^,]*,/, '') // tolerate a data: URL
  const audio = new Uint8Array(Buffer.from(b64, 'base64'))
  if (audio.length === 0) throw new TypeError('transcribeWhisper: áudio vazio')
  if (audio.length > MAX_AUDIO_BYTES) throw new RangeError('transcribeWhisper: áudio acima de 50 MB')
  if (!Object.hasOwn(WHISPER_PROFILES, profile)) throw new RangeError(`perfil Whisper desconhecido "${profile}"`)
  const mime = typeof mimeType === 'string' ? mimeType : ''
  let r: TranscribeResult
  try {
    r = (await request({ op: 'transcribe', profile, audio, mimeType: mime }, onProgress)) as TranscribeResult
  } catch (err) {
    if (!(err instanceof VoiceWorkerError && err.code === 'UNSUPPORTED_AUDIO' && canDecodeWithChromium())) throw err
    onProgress?.({ phase: 'decode' })
    const pcm = await decodeWithChromium(audio)
    r = (await request({ op: 'transcribe', profile, pcm }, onProgress)) as TranscribeResult
  }
  remember(r)
  return r.text
}

export async function prepareVoiceModels(
  what: 'tts' | 'stt',
  onProgress?: (p: VoiceProgress) => void,
  profile: WhisperProfile = whisperProfile
): Promise<void> {
  if (what !== 'tts' && what !== 'stt') throw new RangeError('prepareVoiceModels: use "tts" ou "stt"')
  if (!Object.hasOwn(WHISPER_PROFILES, profile)) throw new RangeError(`perfil Whisper desconhecido "${profile}"`)
  const r = await request({ op: 'prepare', what, profile }, onProgress)
  if (what === 'stt') remember(r as TranscribeResult)
}

export function stopVoiceEngine(): Promise<void> {
  lastState.clear()
  return stop()
}
