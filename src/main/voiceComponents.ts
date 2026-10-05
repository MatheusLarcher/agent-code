/**
 * Settings › Voz: install each piece of the on-device voice stack on its own —
 * Kokoro (read-aloud) and Parakeet (dictation) — and test the transcription end
 * to end. Same download/prepare paths (and the same `speechSetupProgress`
 * notice) as the on-demand use from the chat, so installing here or on the
 * first use are interchangeable.
 */
import type { IpcMain } from 'electron'
import { Channels, type SpeechSetupProgress, type VoiceComponent, type VoiceInstallStatus, type VoiceSelfTest } from '../shared/ipc'
import { kokoroInstalled, parakeetInstalled, prepareVoiceModels } from './voice'
import { ensureVoiceCacheDir, errorText, senderReport, speak, transcribe, withReporter } from './voiceService'

type Send = (p: SpeechSetupProgress) => void

/** What Kokoro says and the model must hear back. Plain words, no names or numbers. */
export const SELF_TEST_PHRASE = 'Olá, este é um teste de transcrição de voz.'

/** Validates what came over IPC; null when it isn't a known component. */
export function parseVoiceComponent(value: unknown): VoiceComponent | null {
  if (typeof value !== 'object' || value === null) return null
  const kind = (value as { kind?: unknown }).kind
  return kind === 'tts' || kind === 'stt' ? { kind } : null
}

const installs = new Map<VoiceComponent['kind'], Promise<void>>()
/** Last install failure per component, so a reopened Settings can still show it. */
const failures = new Map<VoiceComponent['kind'], string>()

export function voiceComponentStatus(c: VoiceComponent): VoiceInstallStatus {
  const dir = ensureVoiceCacheDir()
  const error = failures.get(c.kind)
  return {
    installed: c.kind === 'tts' ? kokoroInstalled(dir) : parakeetInstalled(dir),
    installing: installs.has(c.kind),
    ...(error ? { error } : {})
  }
}

/** Downloads/prepares one component. A second call for the same one joins the first. */
export function installVoiceComponent(c: VoiceComponent, send?: Send): Promise<void> {
  const running = installs.get(c.kind)
  if (running) return running
  const report = send ?? (() => {})
  failures.delete(c.kind)
  ensureVoiceCacheDir()
  const task = withReporter(c.kind, report, (r) => prepareVoiceModels(c.kind, (p) => r.onProgress(p)))
    .catch((err: unknown) => {
      failures.set(c.kind, errorText(err))
      report({ stage: 'error', message: `Não consegui instalar: ${errorText(err)}` })
      throw err
    })
    .finally(() => installs.delete(c.kind))
  installs.set(c.kind, task)
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
 * Kokoro speaks SELF_TEST_PHRASE and Parakeet transcribes it back. Exercises
 * the whole chain (download, load, GPU/CPU, decode) without needing a
 * microphone. Kokoro downloads first if it isn't installed yet.
 */
export async function testTranscription(send?: Send): Promise<VoiceSelfTest> {
  const report = send ?? (() => {})
  const audio = await speak(SELF_TEST_PHRASE, {}, report)
  const heard = await transcribe(audio.base64, audio.mimeType, report)
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
    if (c?.kind !== 'stt') return { ok: false, expected: SELF_TEST_PHRASE, error: 'modelo de transcrição desconhecido' }
    try {
      return await testTranscription(senderReport(e.sender))
    } catch (err) {
      return { ok: false, expected: SELF_TEST_PHRASE, error: errorText(err) }
    }
  })
}
