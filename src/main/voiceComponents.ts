/**
 * Settings › Voz: install each piece of the on-device voice stack on its own —
 * Kokoro, any Whisper model, any Parakeet/Canary model — and test a
 * transcription model end to end. Same download/prepare paths (and the same
 * `speechSetupProgress` notice) as the on-demand use from the chat, so
 * installing here or on the first use are interchangeable.
 */
import type { IpcMain } from 'electron'
import {
  Channels,
  isWhisperModelId,
  LOCAL_SPEECH_MODELS,
  type SpeechSetupProgress,
  type VoiceComponent,
  type VoiceInstallStatus,
  type VoiceSelfTest
} from '../shared/ipc'
import { isLocalSpeechInstalled, prepareLocalSpeech, transcribeLocal } from './speech'
import { kokoroInstalled, prepareVoiceModels, transcribeWhisper, whisperInstalled } from './voice'
import { ensureVoiceCacheDir, errorText, senderReport, speak, withReporter } from './voiceService'

type Send = (p: SpeechSetupProgress) => void

/** What Kokoro says and the model must hear back. Plain words, no names or numbers. */
export const SELF_TEST_PHRASE = 'Olá, este é um teste de transcrição de voz.'

/** Validates what came over IPC; null when it isn't a known component. */
export function parseVoiceComponent(value: unknown): VoiceComponent | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as { kind?: unknown; model?: unknown }
  if (v.kind === 'tts') return { kind: 'tts' }
  if (v.kind === 'whisper' && isWhisperModelId(v.model)) return { kind: 'whisper', model: v.model }
  if (v.kind === 'local' && typeof v.model === 'string' && LOCAL_SPEECH_MODELS.some((m) => m.id === v.model)) {
    return { kind: 'local', model: v.model }
  }
  return null
}

const keyOf = (c: VoiceComponent): string => (c.kind === 'tts' ? 'tts' : `${c.kind}:${c.model}`)

const installs = new Map<string, Promise<void>>()
/** Last install failure per component, so a reopened Settings can still show it. */
const failures = new Map<string, string>()

export function voiceComponentStatus(c: VoiceComponent): VoiceInstallStatus {
  const key = keyOf(c)
  const installing = installs.has(key)
  const error = failures.get(key)
  const extra = error ? { error } : {}
  if (c.kind === 'local') return { installed: isLocalSpeechInstalled(c.model), installing, ...extra }
  const dir = ensureVoiceCacheDir()
  return { installed: c.kind === 'tts' ? kokoroInstalled(dir) : whisperInstalled(dir, c.model), installing, ...extra }
}

function runInstall(c: VoiceComponent, send: Send): Promise<void> {
  if (c.kind === 'local') return prepareLocalSpeech(c.model, send)
  ensureVoiceCacheDir()
  if (c.kind === 'tts') return withReporter('tts', send, (r) => prepareVoiceModels('tts', (p) => r.onProgress(p)))
  return withReporter('stt', send, (r) => prepareVoiceModels('stt', (p) => r.onProgress(p), c.model))
}

/** Downloads/prepares one component. A second call for the same one joins the first. */
export function installVoiceComponent(c: VoiceComponent, send?: Send): Promise<void> {
  const key = keyOf(c)
  const running = installs.get(key)
  if (running) return running
  const report = send ?? (() => {})
  failures.delete(key)
  const task = runInstall(c, report)
    .catch((err: unknown) => {
      failures.set(key, errorText(err))
      report({ stage: 'error', message: `Não consegui instalar: ${errorText(err)}` })
      throw err
    })
    .finally(() => installs.delete(key))
  installs.set(key, task)
  return task
}

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

/** Share of the expected words that came back (order ignored), 0..1. */
export function wordRecall(expected: string, heard: string): number {
  const want = words(expected)
  if (want.length === 0) return 0
  const got = new Set(words(heard))
  return want.filter((w) => got.has(w)).length / want.length
}

/**
 * Kokoro speaks SELF_TEST_PHRASE and the chosen transcription model transcribes
 * it back. Exercises the whole chain (download, load, GPU/CPU, decode) without
 * needing a microphone. Kokoro downloads first if it isn't installed yet.
 */
export async function testTranscription(c: VoiceComponent, send?: Send): Promise<VoiceSelfTest> {
  if (c.kind === 'tts') throw new RangeError('o teste é de um modelo de transcrição')
  const report = send ?? (() => {})
  const audio = await speak(SELF_TEST_PHRASE, {}, report)
  const heard =
    c.kind === 'whisper'
      ? await withReporter('stt', report, (r) =>
          transcribeWhisper(audio.base64, audio.mimeType, (p) => r.onProgress(p), c.model)
        )
      : await transcribeLocal(Buffer.from(audio.base64, 'base64'), c.model, report)
  return { ok: wordRecall(SELF_TEST_PHRASE, heard) >= 0.7, expected: SELF_TEST_PHRASE, heard: heard.trim() }
}

export function registerVoiceComponentIpc(ipcMain: IpcMain): void {
  ipcMain.handle(Channels.voiceComponentStatus, (_e, raw: unknown) => {
    const c = parseVoiceComponent(raw)
    return c ? voiceComponentStatus(c) : { installed: false, installing: false }
  })
  ipcMain.handle(Channels.voiceComponentInstall, async (e, raw: unknown) => {
    const c = parseVoiceComponent(raw)
    if (!c) return { ok: false, error: 'componente de voz desconhecido' }
    try {
      await installVoiceComponent(c, senderReport(e.sender))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errorText(err) }
    }
  })
  ipcMain.handle(Channels.voiceTestTranscription, async (e, raw: unknown): Promise<VoiceSelfTest> => {
    const c = parseVoiceComponent(raw)
    if (!c || c.kind === 'tts') return { ok: false, expected: SELF_TEST_PHRASE, error: 'modelo de transcrição desconhecido' }
    try {
      return await testTranscription(c, senderReport(e.sender))
    } catch (err) {
      return { ok: false, expected: SELF_TEST_PHRASE, error: errorText(err) }
    }
  })
}
