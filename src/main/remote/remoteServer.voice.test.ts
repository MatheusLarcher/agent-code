// @vitest-environment node
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { request } from 'node:http'
import { RemoteServer } from './remoteServer'

// Voz do celular pelo HTTP real: sem chave nenhuma, o PC transcreve com o motor
// configurado e sintetiza com a voz/velocidade da config (o celular toca a 1×).

const transcribed: Array<{ audioBase64: string; mimeType: string }> = []
const spoken: Array<{ text: string; treated?: boolean }> = []
const srv = new RemoteServer({
  onInbound: () => undefined,
  apkPath: () => 'C:/nonexistent/agent-remote.apk',
  wwwDir: () => 'C:/nonexistent/www',
  transcribe: async (audioBase64, mimeType) => {
    transcribed.push({ audioBase64, mimeType })
    if (audioBase64 === 'quebrado') throw new Error('áudio não decodificável')
    return 'olá mundo'
  },
  tts: async (text, opts) => {
    spoken.push({ text, treated: opts?.treated })
    return { base64: 'UklGRg==', mimeType: 'audio/wav' }
  },
  ttsParts: (text) => text.split('|')
})
let base = ''
let tok = ''

function call(path: string, payload?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? '' : JSON.stringify(payload)
    const req = request(
      `${base}${path}${path.includes('?') ? '&' : '?'}token=${tok}`,
      {
        method: payload === undefined ? 'GET' : 'POST',
        headers: payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      },
      (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: body ? JSON.parse(body) : {} }))
      }
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

beforeAll(async () => {
  const info = await srv.start()
  tok = info.token
  base = `http://127.0.0.1:${info.port}`
})
afterAll(async () => {
  await srv.stop()
})

describe('RemoteServer — voz local do celular', () => {
  it('/api/state liga a voz sem depender de chave', async () => {
    expect((await call('/api/state')).json.voiceReady).toBe(true)
  })

  it('/api/transcribe repassa WebM/Opus com o mime do celular e devolve o texto', async () => {
    const r = await call('/api/transcribe', { audioBase64: 'GkXfow==', mimeType: 'audio/webm;codecs=opus' })
    expect(r.json).toEqual({ ok: true, text: 'olá mundo' })
    expect(transcribed.at(-1)).toEqual({ audioBase64: 'GkXfow==', mimeType: 'audio/webm;codecs=opus' })
  })

  it('/api/transcribe: erro do motor volta como ok:false legível (sem "no-key")', async () => {
    const r = await call('/api/transcribe', { audioBase64: 'quebrado', mimeType: 'audio/webm' })
    expect(r.json).toEqual({ ok: false, error: 'áudio não decodificável' })
    expect((await call('/api/transcribe', { mimeType: 'audio/webm' })).status).toBe(400)
  })

  it('/api/tts-parts divide e /api/tts sintetiza cada parte já tratada', async () => {
    const parts = await call('/api/tts-parts', { text: 'Primeira frase.|Segunda frase.' })
    expect(parts.json).toEqual({ ok: true, parts: ['Primeira frase.', 'Segunda frase.'] })
    const r = await call('/api/tts', { text: 'Primeira frase.', treated: true })
    expect(r.json).toEqual({ ok: true, audioBase64: 'UklGRg==', mimeType: 'audio/wav' })
    expect(spoken.at(-1)).toEqual({ text: 'Primeira frase.', treated: true })
  })

  it('/api/tts de um cliente antigo (texto cru, sem `treated`) pede o tratamento no PC', async () => {
    await call('/api/tts', { text: '**Resposta** longa' })
    expect(spoken.at(-1)).toEqual({ text: '**Resposta** longa', treated: false })
    expect((await call('/api/tts', { text: '   ' })).status).toBe(400)
  })
})
