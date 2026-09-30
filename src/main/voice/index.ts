/**
 * Local voice engine — speech in and out with no cloud service.
 *
 *   TTS: Kokoro-82M (fp32, CPU) with pt-BR phonemes from eSpeak NG (WASM).
 *   STT: Whisper via @huggingface/transformers (onnxruntime-node).
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
 * transcribeWhisper(audioBase64, mimeType, onProgress?) => Promise<string>
 *   Portuguese transcription. Accepts WAV (desktop recorder) and WebM/Ogg Opus
 *   (phone MediaRecorder), decoded in the worker with WASM — no ffmpeg. Inside
 *   Electron, other formats (mp4/AAC, mp3) fall back to Chromium's decoder.
 *
 * prepareVoiceModels(what: 'tts' | 'stt', onProgress?) => Promise<void>
 *   Downloads/loads the models ahead of time so the first real call is fast.
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
  KOKORO_VOICES,
  WHISPER_PROFILES,
  type KokoroVoice,
  type SynthesisResult,
  type VoiceProgress,
  type WhisperProfile
} from './protocol'

export { KOKORO_VOICES as LOCAL_VOICES, WHISPER_PROFILES, VoiceWorkerError }
export type { KokoroVoice as LocalVoice, SynthesisResult, VoiceProgress, WhisperProfile }

/**
 * Chosen by scripts/voice/bench-whisper.mjs on the dev machine (i7-14650HX,
 * 8 ORT threads): best quality under ~3 s for 5 s of audio. Median latency
 * 5 s / 13 s / 13 s+noise(5 dB): small-fp32 2.05 / 3.57 / 3.23 s, WER 0 / 0 / 0%;
 * small-q8 1.73 / 3.38 / 3.41 s, WER 0 / 0 / 2.4%; turbo-q8 4.54 / 6.68 / 6.54 s
 * (over budget); turbo-q4 ~20 s. Full precision wins the tie with q8.
 */
export const WHISPER_PROFILE: WhisperProfile = 'small-fp32'

const MAX_TEXT_CHARS = 20_000
const MAX_AUDIO_BYTES = 50 * 1024 * 1024

let whisperProfile: WhisperProfile = WHISPER_PROFILE

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
  onProgress?: (p: VoiceProgress) => void
): Promise<string> {
  if (typeof audioBase64 !== 'string' || !audioBase64) throw new TypeError('transcribeWhisper: áudio vazio')
  const b64 = audioBase64.replace(/^data:[^,]*,/, '') // tolerate a data: URL
  const audio = new Uint8Array(Buffer.from(b64, 'base64'))
  if (audio.length === 0) throw new TypeError('transcribeWhisper: áudio vazio')
  if (audio.length > MAX_AUDIO_BYTES) throw new RangeError('transcribeWhisper: áudio acima de 50 MB')
  const mime = typeof mimeType === 'string' ? mimeType : ''
  try {
    return (await request({ op: 'transcribe', profile: whisperProfile, audio, mimeType: mime }, onProgress)) as string
  } catch (err) {
    if (!(err instanceof VoiceWorkerError && err.code === 'UNSUPPORTED_AUDIO' && canDecodeWithChromium())) throw err
    onProgress?.({ phase: 'decode' })
    const pcm = await decodeWithChromium(audio)
    return (await request({ op: 'transcribe', profile: whisperProfile, pcm }, onProgress)) as string
  }
}

export async function prepareVoiceModels(what: 'tts' | 'stt', onProgress?: (p: VoiceProgress) => void): Promise<void> {
  if (what !== 'tts' && what !== 'stt') throw new RangeError('prepareVoiceModels: use "tts" ou "stt"')
  await request({ op: 'prepare', what, profile: whisperProfile }, onProgress)
}

export function stopVoiceEngine(): Promise<void> {
  return stop()
}
