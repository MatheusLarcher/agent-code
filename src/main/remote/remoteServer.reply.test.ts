import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { request } from 'node:http'
import { RemoteServer } from './remoteServer'
import type { RemoteConversation } from '../../shared/ipc'
import type { RemoteCentral } from '../../shared/central'

/**
 * Responder uma mensagem da Central pelo celular: `replyTo` no POST /api/send é
 * validado no main (texto 1..100, só na Central, id de entrada respondível do
 * retrato publicado — entregue/resposta, com destino, deste PC). Fora disso: 400
 * e nada é repassado. Sem `replyTo`, o envio de sempre.
 */

const inbound: unknown[][] = []
const server = new RemoteServer({
  onInbound: (...args) => inbound.push(args),
  apkPath: () => 'C:/nonexistent/agent-remote.apk',
  wwwDir: () => 'C:/nonexistent/www'
})

const anchor = { convId: 'c1', msgId: 'u1' }
const snapshot: RemoteCentral = {
  entries: [
    { kind: 'request', id: 'r1', ts: 1, text: 'faz o login', state: 'delivered', anchor },
    { kind: 'request', id: 'r2', ts: 2, text: 'outro PC', state: 'delivered', anchor, foreign: true },
    { kind: 'request', id: 'r3', ts: 3, text: 'esperando', state: 'asking' },
    {
      kind: 'reply',
      id: 'reply:r1',
      ts: 4,
      requestId: 'r1',
      anchor,
      who: 'p · Login',
      color: '#7fb3d5',
      notes: [],
      answer: 'feito',
      activity: { segments: [], text: '', count: 0, errors: 0, done: true }
    },
    {
      kind: 'reply',
      id: 'reply:r9',
      ts: 5,
      requestId: 'r9',
      anchor,
      who: 'p · Login',
      color: '#7fb3d5',
      notes: [],
      activity: { segments: [], text: '', count: 0, errors: 0, done: true },
      foreign: true
    }
  ],
  rail: [],
  questions: []
}
const conversations: RemoteConversation[] = [
  { id: 'central', title: 'Central', cwd: '', busy: false, connected: false, updatedAt: 5, messages: [], central: snapshot },
  { id: 'c1', title: 'Login', cwd: '/p', busy: false, connected: true, updatedAt: 4, messages: [] }
]

let base = ''
let token = ''
beforeAll(async () => {
  const info = await server.start()
  token = info.token
  base = `http://127.0.0.1:${info.port}`
  server.setState({ conversations })
})
afterAll(async () => {
  await server.stop()
})

function send(payload: unknown): Promise<{ status: number; json: unknown }> {
  const body = JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const req = request(
      `${base}/api/send?token=${token}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let text = ''
        res.on('data', (d) => (text += d))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }))
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

describe('POST /api/send com replyTo', () => {
  it('200: pedido entregue e bloco de resposta deste PC; o id vai ao renderer (aparado)', async () => {
    inbound.length = 0
    expect((await send({ convId: 'central', text: 'e o logout?', replyTo: 'r1' })).status).toBe(200)
    expect((await send({ convId: 'central', text: 'valeu', replyTo: ' reply:r1 ' })).status).toBe(200)
    expect(inbound).toEqual([
      ['central', 'e o logout?', [], [], 'r1'],
      ['central', 'valeu', [], [], 'reply:r1']
    ])
  })

  it('sem replyTo (ou null): o envio de sempre, sem o 5º argumento', async () => {
    inbound.length = 0
    expect((await send({ convId: 'central', text: 'oi' })).status).toBe(200)
    expect((await send({ convId: 'central', text: 'oi2', replyTo: null })).status).toBe(200)
    expect(inbound).toEqual([
      ['central', 'oi', [], []],
      ['central', 'oi2', [], []]
    ])
  })

  it('400 e nada repassado: formato inválido, fora da Central, inexistente, de outro PC ou sem destino', async () => {
    inbound.length = 0
    const bad: unknown[] = [
      { convId: 'central', text: 'x', replyTo: '' },
      { convId: 'central', text: 'x', replyTo: '   ' },
      { convId: 'central', text: 'x', replyTo: 'y'.repeat(101) },
      { convId: 'central', text: 'x', replyTo: 7 },
      { convId: 'central', text: 'x', replyTo: { id: 'r1' } },
      { convId: 'c1', text: 'x', replyTo: 'r1' },
      { convId: 'central', text: 'x', replyTo: 'nao-existe' },
      { convId: 'central', text: 'x', replyTo: 'r2' },
      { convId: 'central', text: 'x', replyTo: 'r3' },
      { convId: 'central', text: 'x', replyTo: 'reply:r9' }
    ]
    for (const body of bad) expect((await send(body)).status, JSON.stringify(body)).toBe(400)
    expect(inbound).toEqual([])
  })
})
