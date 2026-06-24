// Thin OpenAI audio client for the chat's voice features. Lives in main so the
// API key never reaches the renderer — the renderer sends audio/text over IPC and
// gets text/audio back. Uses Node's built-in fetch/FormData/Blob (no npm dep).

const API = 'https://api.openai.com/v1'

/** Speech-to-text. Records come from the renderer's MediaRecorder (webm/opus by
 *  default). Returns the transcript text. */
export async function transcribeAudio(
  apiKey: string,
  audioBase64: string,
  mimeType: string
): Promise<string> {
  const buf = Buffer.from(audioBase64, 'base64')
  const type = mimeType || 'audio/webm'
  const ext = type.includes('webm')
    ? 'webm'
    : type.includes('mp4') || type.includes('m4a')
      ? 'mp4'
      : type.includes('ogg')
        ? 'ogg'
        : type.includes('mpeg')
          ? 'mp3'
          : 'wav'

  const form = new FormData()
  form.append('file', new Blob([buf], { type }), `audio.${ext}`)
  form.append('model', 'gpt-4o-mini-transcribe')

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

/** Reading pace as an instruction (gpt-4o-mini-tts ignores the numeric `speed`
 *  param, so we steer pace through the prompt instead). */
function paceInstruction(speed: number): string {
  if (speed <= 0.85) return ' Fale devagar, em ritmo pausado.'
  if (speed >= 1.4) return ' Fale bem rápido, em ritmo acelerado.'
  if (speed >= 1.15) return ' Fale um pouco mais rápido que o normal.'
  return ''
}

/** Text-to-speech. Returns base64 MP3 audio for the renderer to play. The text is
 *  already treated for reading (see toSpeechText); the instructions keep the
 *  delivery natural, in the text's own language, at the chosen pace. */
export async function synthesizeSpeech(
  apiKey: string,
  text: string,
  voice = 'alloy',
  speed = 1
): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(`${API}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      input: text,
      voice: voice || 'alloy',
      response_format: 'mp3',
      instructions: `Leia de forma natural e clara, no mesmo idioma do texto.${paceInstruction(speed)}`
    })
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`OpenAI tts ${res.status}: ${detail.slice(0, 300)}`)
  }
  const ab = await res.arrayBuffer()
  return { base64: Buffer.from(ab).toString('base64'), mimeType: 'audio/mpeg' }
}
