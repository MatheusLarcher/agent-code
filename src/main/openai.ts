// Thin OpenAI audio client for the chat's voice features. Lives in main so the
// API key never reaches the renderer — the renderer sends audio/text over IPC and
// gets text/audio back. Uses Node's built-in fetch/FormData/Blob (no npm dep).

import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const API = 'https://api.openai.com/v1'

const DEBUG_AUDIO_KEEP = 8

/** Dumps the exact audio segment sent to the STT API, so the user can play it
 *  back and tell whether a bad transcript came from a noisy capture or from
 *  the model itself. Keeps only the last few files — this is a debug aid, not
 *  a recording feature, so it must not grow unbounded on disk. */
export async function saveDebugAudioSegment(
  debugDir: string,
  audioBase64: string,
  mimeType: string
): Promise<string> {
  await mkdir(debugDir, { recursive: true })
  const file = join(debugDir, `segmento-${Date.now()}.${extFromMime(mimeType)}`)
  await writeFile(file, Buffer.from(audioBase64, 'base64'))
  const entries = (await readdir(debugDir)).filter((name) => name.startsWith('segmento-')).sort()
  const excess = entries.length - DEBUG_AUDIO_KEEP
  if (excess > 0) {
    await Promise.all(entries.slice(0, excess).map((name) => unlink(join(debugDir, name)).catch(() => {})))
  }
  return file
}

/** File extension matching a MediaRecorder mime type (webm/opus by default). */
function extFromMime(mimeType: string): string {
  const type = mimeType || 'audio/webm'
  return type.includes('webm')
    ? 'webm'
    : type.includes('mp4') || type.includes('m4a')
      ? 'mp4'
      : type.includes('ogg')
        ? 'ogg'
        : type.includes('mpeg')
          ? 'mp3'
          : 'wav'
}

/** Speech-to-text. Records come from the renderer's MediaRecorder (webm/opus by
 *  default). Returns the transcript text. */
export async function transcribeAudio(
  apiKey: string,
  audioBase64: string,
  mimeType: string
): Promise<string> {
  const buf = Buffer.from(audioBase64, 'base64')
  const type = mimeType || 'audio/webm'
  const ext = extFromMime(type)

  const form = new FormData()
  form.append('file', new Blob([buf], { type }), `audio.${ext}`)
  // Full gpt-4o-transcribe (not the -mini): noticeably better pt-BR accuracy. The
  // renderer's VAD already drops silence-only audio, so we don't pay to transcribe
  // quiet stretches that would otherwise come back as hallucinated words.
  form.append('model', 'gpt-4o-transcribe')
  // Force Portuguese so it doesn't guess the language (better accuracy for pt-BR).
  form.append('language', 'pt')
  // Bias prompt: short/noisy segments sometimes come back hallucinated in another
  // alphabet entirely (e.g. Cyrillic) even with `language` set — a pt-BR context
  // prompt anchors the decoder to Brazilian Portuguese tech dictation.
  form.append(
    'prompt',
    'Transcrição de um ditado em português do Brasil sobre programação e desenvolvimento de software.'
  )

  const res = await fetch(`${API}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`OpenAI transcribe ${res.status}: ${detail.slice(0, 300)}`)
  }
  const data = (await res.json()) as { text?: string }
  return data.text ?? ''
}

/** Text-to-speech. Returns base64 MP3 audio for the renderer to play. The text is
 *  already treated for reading (see toSpeechText); the instructions keep the
 *  delivery natural and in the text's own language. Reading SPEED is applied in
 *  the renderer (HTMLAudioElement.playbackRate) — deterministic and instant,
 *  unlike the model's pace which gpt-4o-mini-tts tends to ignore. */
export async function synthesizeSpeech(
  apiKey: string,
  text: string,
  voice = 'alloy'
): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(`${API}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      input: text,
      voice: voice || 'alloy',
      response_format: 'mp3',
      // Always read in Brazilian Portuguese instead of guessing from the text.
      instructions: 'Leia sempre em português do Brasil (pt-BR), de forma natural e clara, com sotaque brasileiro.'
    })
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`OpenAI tts ${res.status}: ${detail.slice(0, 300)}`)
  }
  const ab = await res.arrayBuffer()
  return { base64: Buffer.from(ab).toString('base64'), mimeType: 'audio/mpeg' }
}
