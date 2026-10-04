import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { request } from 'node:http'
import { RemoteServer } from './remoteServer'
import type { RemoteConversation, RemotePairedDevice } from '../../shared/ipc'
import type { RemoteCentral, RemoteCentralChoose } from '../../shared/central'

/**
 * A Central no celular, do lado do PC: a rota do "Para onde vai?" (token,
 * celular pareado e corpo validados na fronteira, antes do renderer), o retrato
 * `central` no `/api/state` e o envio para a Central pelo `/api/send` de sempre.
 */

const chosen: RemoteCentralChoose[] = []
const inbound: Array<{ convId: string; text: string }> = []
let paired: RemotePairedDevice | null = null
const server = new RemoteServer({
  onInbound: (convId, text) => inbound.push({ convId, text }),
  onCentralChoose: (choice) => chosen.push(choice),
  apkPath: () => 'C:/nonexistent/agent-remote.apk',
  wwwDir: () => 'C:/nonexistent/www',
  loadPairedDevice: () => paired,
  savePairedDevice: (device) => {
    paired = device
  }
})

const snapshot: RemoteCentral = {
  entries: [
    {
      kind: 'request',
      id: 'r1',
      ts: 1,
      text: 'deixa mais escuro',
      state: 'asking',
      origin: 'central',
      ask: { reason: 'low-confidence', options: [{ label: 'Tela de login', sub: 'agent-code', icon: null, glyph: 'project', best: true }] }
    }
  ],
  rail: [{ convId: 'c1', project: 'agent-code', title: 'Tela de login', color: '#7fb3d5', icon: null, sandbox: false }],
  questions: []
}
const centralConv: RemoteConversation = {
  id: 'central',
  title: 'Central',
  cwd: '',
  busy: false,
  connected: false,
  updatedAt: 5,
  messages: [],
  central: snapshot
}
const destination: RemoteConversation = {
  id: 'c1',
  title: 'Tela de login',
  cwd: '/proj',
  busy: true,
  connected: true,
  updatedAt: 4,
  messages: [{ kind: 'user', id: 'u1', text: 'faz o login' }]
}

let base = ''
let token = ''

beforeAll(async () => {
  const info = await server.start()
  token = info.token
  base = `http://127.0.0.1:${info.port}`
  server.setState({ conversations: [centralConv, destination] })
})

afterAll(async () => {
  await server.stop()
})

/** Uma chamada HTTP de verdade; `body` cru (para mandar JSON quebrado). */
function call(path: string, body?: string, method = body === undefined ? 'GET' : 'POST'): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      base + path,
      { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let text = ''
        res.on('data', (d) => (text += d))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }))
      }
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}
const choose = (query: string, payload: unknown): Promise<{ status: number; json: unknown }> =>
  call(`/api/central-choose${query}`, JSON.stringify(payload))

describe('RemoteServer — a Central no celular', () => {
  it('POST /api/central-choose sem token (ou com outro) é 401 e não repassa nada', async () => {
    expect((await choose('', { entryId: 'r1', option: 0 })).status).toBe(401)
    expect((await choose('?token=errado', { entryId: 'r1', option: 0 })).status).toBe(401)
    expect(chosen).toEqual([])
  })

  it('de outro celular é 409 (um celular por PC) e não repassa nada', async () => {
    expect((await call(`/api/state?token=${token}&dev=fone-A&devname=Galaxy`)).status).toBe(200)
    expect(paired?.id).toBe('fone-A')
    const other = await choose(`?token=${token}&dev=fone-B`, { entryId: 'r1', option: 0 })
    expect(other.status).toBe(409)
    expect((other.json as { error: string }).error).toBe('another-device')
    expect(chosen).toEqual([])
  })

  it('corpo fora do contrato é 400: entryId ausente/vazio/longo, option não inteira ou fora de 0..20, JSON ruim', async () => {
    const q = `?token=${token}&dev=fone-A`
    const bodies: unknown[] = [
      {},
      { option: 0 },
      { entryId: '', option: 0 },
      { entryId: '   ', option: 0 },
      { entryId: 'x'.repeat(101), option: 0 },
      { entryId: 7, option: 0 },
      { entryId: 'r1' },
      { entryId: 'r1', option: 1.5 },
      { entryId: 'r1', option: -1 },
      { entryId: 'r1', option: 21 },
      { entryId: 'r1', option: '1' },
      { entryId: 'r1', option: null },
      [],
      null,
      'r1'
    ]
    for (const body of bodies) {
      const r = await choose(q, body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect((r.json as { ok: boolean }).ok).toBe(false)
    }
    expect((await call(`/api/central-choose${q}`, '{"entryId": "r1", "option":')).status).toBe(400)
    expect((await call(`/api/central-choose${q}`, '')).status).toBe(400)
    expect(chosen).toEqual([])
  })

  it('200 repassa exatamente { entryId, option } (limites inclusos, campos extras fora)', async () => {
    const q = `?token=${token}&dev=fone-A`
    const r = await choose(q, { entryId: 'req-1', option: 2 })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true })
    expect((await choose(q, { entryId: 'y'.repeat(100), option: 20 })).status).toBe(200)
    expect((await choose(q, { entryId: ' req-2 ', option: 0, convId: 'c1', evil: true })).status).toBe(200)
    expect(chosen).toEqual([
      { entryId: 'req-1', option: 2 },
      { entryId: 'y'.repeat(100), option: 20 },
      { entryId: 'req-2', option: 0 }
    ])
  })

  it('só POST: GET na rota é 404', async () => {
    expect((await call(`/api/central-choose?token=${token}&dev=fone-A`)).status).toBe(404)
  })

  it('/api/state leva o retrato `central` da Central (sem as mensagens) e só nela', async () => {
    const r = await call(`/api/state?token=${token}&dev=fone-A`)
    expect(r.status).toBe(200)
    const convs = (r.json as { conversations: Array<Record<string, unknown>> }).conversations
    const central = convs.find((c) => c.id === 'central')
    expect(central?.central).toEqual(snapshot)
    expect(central?.messages).toBeUndefined()
    expect(central?.messageCount).toBe(0)
    expect(convs.find((c) => c.id === 'c1')).not.toHaveProperty('central')
  })

  it('enviar para a Central é o /api/send de sempre, com convId "central"', async () => {
    const r = await call(`/api/send?token=${token}&dev=fone-A`, JSON.stringify({ convId: 'central', text: 'quanto tá o dólar?' }))
    expect(r.status).toBe(200)
    expect(inbound).toContainEqual({ convId: 'central', text: 'quanto tá o dólar?' })
  })
})
