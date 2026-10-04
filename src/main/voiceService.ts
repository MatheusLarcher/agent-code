/**
 * App-side glue for the local voice engine (src/main/voice): picks the voice,
 * speed and dictation engine from the config, points the engine at its model
 * folder, and turns its download progress into the `speechSetupProgress` notice
 * the chat already shows. Used by the desktop IPC and by the phone bridge, so
 * both behave the same. Nothing here talks to the network except the one-time
 * model downloads the engine does itself.
 */
import { join } from 'node:path'
import type { IpcMain, WebContents } from 'electron'
import {
  Channels,
  DEFAULT_LOCAL_SPEECH_MODEL,
  DEFAULT_WHISPER_MODEL,
  isVoiceId,
  isWhisperModelId,
  LOCAL_SPEECH_MODELS,
  normalizeVoiceSpeed,
  type SpeechSetupProgress,
  type VoiceInstallStatus,
  type WhisperModelId,
  type WhisperStatus
} from '../shared/ipc'
import { splitForSpeech, toSpeechText } from '../shared/speechText'
import { loadConfig } from './config'
import { transcribeLocal } from './speech'
import { getCacheInfo } from './store'
import {
  getWhisperStatus,
  prepareVoiceModels,
  setVoiceCacheDir,
  setWhisperProfile,
  stopVoiceEngine,
  synthesizeLocal,
  transcribeWhisper,
  voiceModelsInstalled
} from './voice'
import { canDecodeWithChromium, decodeWithChromium } from './voice/chromiumDecode'
import { concatSamples, encodeWavPcm16, isWav, noiseFloor, parseWav } from './voice/pcm'
import { createSetupReporter, type VoiceTask } from './voiceProgress'

type Send = (p: SpeechSetupProgress) => void

/** The engine refuses more than 20 000 characters per call; long text goes in slices. */
const MAX_SLICE_CHARS = 15_000
/** Hard ceiling for one read-aloud request (≈ an hour of speech). */
const MAX_TEXT_CHARS = 200_000

let cacheDir = ''

/** Models live in the machine-local cache folder (never the synced one). Re-read
 *  on every call: the user can move the data folder while the app runs. */
export function ensureVoiceCacheDir(): string {
  const dir = join(getCacheInfo().localDir, 'voice-models')
  if (dir === cacheDir) return dir
  setVoiceCacheDir(dir)
  cacheDir = dir
  return dir
}

export async function withReporter<T>(task: VoiceTask, send: Send | undefined, run: (r: ReturnType<typeof createSetupReporter>) => Promise<T>): Promise<T> {
  const reporter = createSetupReporter(task, send ?? (() => {}))
  try {
    const out = await run(reporter)
    reporter.finish()
    return out
  } catch (err) {
    reporter.finish(err)
    throw err
  }
}

export interface SpeakOptions {
  voice?: unknown
  speed?: unknown
}

/** Voice/speed for one request: a valid override wins, else the saved config. */
export function resolveSpeakOptions(opts: SpeakOptions | undefined): { voice: string; speed: number } {
  const saved = loadConfig().voice
  const voice = isVoiceId(opts?.voice) ? opts.voice : isVoiceId(saved?.voice) ? saved.voice : 'pf_dora'
  const speed = typeof opts?.speed === 'number' ? normalizeVoiceSpeed(opts.speed) : normalizeVoiceSpeed(saved?.speed)
  return { voice, speed }
}

/** Slices of at most MAX_SLICE_CHARS, cut between sentences. */
function sliceText(text: string): string[] {
  if (text.length <= MAX_SLICE_CHARS) return [text]
  const slices: string[] = []
  let cur = ''
  for (const part of splitForSpeech(text)) {
    if (cur && cur.length + 1 + part.length > MAX_SLICE_CHARS) {
      slices.push(cur)
      cur = ''
    }
    cur = cur ? `${cur} ${part}` : part
  }
  if (cur) slices.push(cur)
  return slices
}

/**
 * Speech for `text` as a base64 WAV. `treat` runs the Markdown → speech cleanup
 * (the phone sends raw answers; the desktop already treats them). Speed is
 * Kokoro's own — the audio must be played at rate 1.
 */
export async function speak(
  text: string,
  opts: SpeakOptions & { treat?: boolean } = {},
  send?: Send
): Promise<{ base64: string; mimeType: string }> {
  if (typeof text !== 'string') throw new TypeError('texto inválido')
  const spoken = (opts.treat ? toSpeechText(text) : text).trim()
  if (!spoken) throw new Error('Não há texto para ler.')
  if (spoken.length > MAX_TEXT_CHARS) throw new RangeError('Texto longo demais para ler em voz alta.')
  const { voice, speed } = resolveSpeakOptions(opts)
  ensureVoiceCacheDir()
  return withReporter('tts', send, async (reporter) => {
    const slices = sliceText(spoken)
    if (slices.length === 1) {
      const r = await synthesizeLocal(slices[0], { voice, speed }, (p) => reporter.onProgress(p))
      return { base64: r.base64, mimeType: r.mimeType }
    }
    const parts: Float32Array[] = []
    let rate = 24000
    for (const slice of slices) {
      const r = await synthesizeLocal(slice, { voice, speed }, (p) => reporter.onProgress(p))
      const pcm = parseWav(Buffer.from(r.base64, 'base64'))
      rate = pcm.sampleRate
      parts.push(pcm.channels[0])
    }
    // The gap is noise floor, not zeros, so the device does not idle between slices.
    const gap = noiseFloor(Math.round(rate * 0.25))
    const joined = parts.flatMap((p, i) => (i === 0 ? [p] : [gap, p]))
    return { base64: encodeWavPcm16(concatSamples(joined), rate).toString('base64'), mimeType: 'audio/wav' }
  })
}

/** Treated, playable pieces of an answer — the phone plays them one by one so
 *  the first audio starts fast and very long answers still work. */
export function speechParts(text: string): string[] {
  return typeof text === 'string' ? splitForSpeech(toSpeechText(text)) : []
}

/** The Python engine reads WAV only; phone audio (WebM/Ogg/mp4) is decoded by
 *  Chromium to 16 kHz mono first. */
async function asWav(audio: Buffer): Promise<Buffer> {
  if (isWav(audio)) return audio
  if (!canDecodeWithChromium()) throw new Error('formato de áudio não suportado pelo motor Python (envie WAV)')
  return encodeWavPcm16(await decodeWithChromium(audio), 16000)
}

/** Transcribe with the engine chosen in Settings ('whisper' by default). */
export async function transcribe(audioBase64: string, mimeType: string, send?: Send): Promise<string> {
  if (typeof audioBase64 !== 'string' || !audioBase64) throw new TypeError('áudio vazio')
  const mime = typeof mimeType === 'string' ? mimeType : ''
  const cfg = loadConfig()
  if (cfg.transcribeEngine === 'local') {
    // Um id de catálogo antigo tentaria baixar um repo sem os pesos esperados.
    const model = LOCAL_SPEECH_MODELS.some((m) => m.id === cfg.localSpeech.model)
      ? cfg.localSpeech.model
      : DEFAULT_LOCAL_SPEECH_MODEL
    const report = send ?? (() => {})
    try {
      return await transcribeLocal(await asWav(Buffer.from(audioBase64, 'base64')), model, report)
    } catch (err) {
      report({ stage: 'error', message: 'Não consegui preparar o reconhecimento de voz.' })
      throw err
    }
  }
  ensureVoiceCacheDir()
  // Read on every call: a model picked in Settings applies to the next dictation.
  setWhisperProfile(resolveWhisperModel(cfg.voice?.whisperModel))
  const text = await withReporter('stt', send, (reporter) => transcribeWhisper(audioBase64, mime, (p) => reporter.onProgress(p)))
  logWhisperDevice()
  return text
}

let loggedDevice = ''
/** One line in the main log whenever the model or its device changes (the
 *  worker's own lines don't always reach the app's stdout). */
function logWhisperDevice(): void {
  const s = getWhisperStatus()
  if (!s.label) return
  const line = `Whisper ${s.profile} em ${s.label}${s.gpuError ? ` — GPU descartada: ${s.gpuError}` : ''}`
  if (line === loggedDevice) return
  loggedDevice = line
  console.log(`[voice] ${line}`)
}

export function resolveWhisperModel(saved: unknown): WhisperModelId {
  return isWhisperModelId(saved) ? saved : DEFAULT_WHISPER_MODEL
}

/** Settings › Voz: the chosen model and where it last ran. */
export function whisperStatus(): WhisperStatus {
  setWhisperProfile(resolveWhisperModel(loadConfig().voice?.whisperModel))
  const s = getWhisperStatus()
  return {
    model: resolveWhisperModel(s.profile),
    device: s.device,
    label: s.label,
    ...(s.gpuError ? { gpuError: s.gpuError } : {})
  }
}

let installing: Promise<void> | null = null

/** Local voice models: present in the cache / being downloaded right now. */
export function voiceInstallStatus(): VoiceInstallStatus {
  ensureVoiceCacheDir()
  return { installed: voiceModelsInstalled(cacheDir, resolveWhisperModel(loadConfig().voice?.whisperModel)), installing: installing !== null }
}

/**
 * Downloads/prepares Kokoro and Whisper ahead of the first use, through the same
 * prepare + progress path the on-demand calls use. A call during an install
 * joins it instead of starting another. One notice covers both models: the
 * per-model "done"/"error" are held back and replaced by the final outcome.
 */
export function installVoice(send?: Send): Promise<void> {
  if (installing) return installing
  ensureVoiceCacheDir()
  const profile = resolveWhisperModel(loadConfig().voice?.whisperModel)
  setWhisperProfile(profile)
  const step: Send = (p) => {
    if (p.stage !== 'done' && p.stage !== 'error') send?.(p)
  }
  const run = (async () => {
    try {
      await withReporter('tts', step, (r) => prepareVoiceModels('tts', (p) => r.onProgress(p)))
      await withReporter('stt', step, (r) => prepareVoiceModels('stt', (p) => r.onProgress(p)))
      send?.({ stage: 'done', message: 'Voz e transcrição instaladas.' })
    } catch (err) {
      send?.({ stage: 'error', message: 'Não consegui instalar a voz e a transcrição. Verifique a conexão e tente de novo.' })
      throw err
    } finally {
      installing = null
    }
  })()
  installing = run
  return run
}

export function senderReport(sender: WebContents): Send {
  return (p) => {
    if (!sender.isDestroyed()) sender.send(Channels.speechSetupProgress, p)
  }
}

export const errorText = (err: unknown): string => String(err instanceof Error ? err.message : err)

/** Desktop IPC. Errors come back as `{ ok: false, error }` so the UI can toast them. */
export function registerVoiceIpc(ipcMain: IpcMain): void {
  ipcMain.handle(Channels.voiceStatus, () => whisperStatus())
  ipcMain.handle(Channels.voiceInstallStatus, () => voiceInstallStatus())
  ipcMain.handle(Channels.voiceInstall, async (e) => {
    try {
      await installVoice(senderReport(e.sender))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errorText(err) }
    }
  })
  ipcMain.handle(Channels.voiceTranscribe, async (e, audioBase64: unknown, mimeType: unknown) => {
    if (typeof audioBase64 !== 'string' || !audioBase64) return { ok: false, error: 'áudio vazio' }
    try {
      return { ok: true, text: await transcribe(audioBase64, typeof mimeType === 'string' ? mimeType : '', senderReport(e.sender)) }
    } catch (err) {
      return { ok: false, error: errorText(err) }
    }
  })
  ipcMain.handle(Channels.voiceTts, async (e, text: unknown, opts: unknown) => {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'texto vazio' }
    const o = typeof opts === 'object' && opts !== null ? (opts as SpeakOptions) : {}
    try {
      const { base64, mimeType } = await speak(text, { voice: o.voice, speed: o.speed }, senderReport(e.sender))
      return { ok: true, audioBase64: base64, mimeType }
    } catch (err) {
      return { ok: false, error: errorText(err) }
    }
  })
}

/** App quit: frees the models' memory (the worker restarts on the next call). */
export function stopVoice(): Promise<void> {
  return stopVoiceEngine().catch(() => undefined)
}
