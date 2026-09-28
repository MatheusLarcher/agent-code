// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:net'
import { WebSocket } from 'ws'
import { ChromeBridge } from './server'
import {
  CHROME_BRIDGE_PORTS,
  ERR_NOT_CONNECTED,
  ERR_TIMEOUT
} from './protocol'

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop'
const TOKEN = 'secret-token'
const ORIGIN = `chrome-extension://${EXT_ID}`

let bridges: ChromeBridge[] = []
let sockets: WebSocket[] = []
let blockers: Server[] = []

// Porta aleatória fixa colidia com as faixas que o Windows reserva (Hyper-V),
// deixando testes intermitentes; pedir ao SO uma porta livre evita isso.
function basePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

async function makeBridge(ports?: number[], helloTimeoutMs = 3000): Promise<ChromeBridge> {
  ports ??= [await basePort()]
  const b = new ChromeBridge({ extensionId: EXT_ID, token: TOKEN, version: '1.2.3', ports, helloTimeoutMs })
  bridges.push(b)
  await b.start()
  return b
}

function open(port: number, origin = ORIGIN): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin })
  sockets.push(ws)
  return ws
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((r) => ws.once('message', (d) => r(JSON.parse(d.toString()))))
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((r) => ws.once('close', (code) => r(code)))
}

async function connect(b: ChromeBridge): Promise<WebSocket> {
  const ws = open(b.getStatus().port!)
  await new Promise((r) => ws.once('open', r))
  const welcome = nextMessage(ws)
  ws.send(JSON.stringify({ type: 'hello', token: TOKEN, version: '1.2.3', userAgent: 'UA' }))
  expect(await welcome).toEqual({ type: 'welcome', version: '1.2.3' })
  return ws
}

afterEach(async () => {
  for (const s of sockets) s.terminate()
  await Promise.all(bridges.map((b) => b.stop()))
  await Promise.all(blockers.map((s) => new Promise((r) => s.close(r))))
  bridges = []
  sockets = []
  blockers = []
})

describe('ChromeBridge', () => {
  it('exporta as portas do contrato', () => {
    expect(CHROME_BRIDGE_PORTS).toEqual([47831, 47832, 47833, 47834, 47835])
  })

  it('handshake ok gera welcome e status conectado', async () => {
    const b = await makeBridge()
    const statuses: boolean[] = []
    b.on('status', (s) => statuses.push(s.connected))
    await connect(b)
    expect(b.getStatus()).toMatchObject({ connected: true, extensionVersion: '1.2.3', userAgent: 'UA' })
    expect(statuses).toContain(true)
  })

  it('responde pong ao ping', async () => {
    const ws = await connect(await makeBridge())
    const m = nextMessage(ws)
    ws.send(JSON.stringify({ type: 'ping' }))
    expect(await m).toEqual({ type: 'pong' })
  })

  it('token errado fecha com 4001', async () => {
    const b = await makeBridge()
    const ws = open(b.getStatus().port!)
    await new Promise((r) => ws.once('open', r))
    const code = closeCode(ws)
    ws.send(JSON.stringify({ type: 'hello', token: 'errado', version: '1', userAgent: 'x' }))
    expect(await code).toBe(4001)
    expect(b.getStatus().connected).toBe(false)
  })

  it('sem hello no prazo fecha com 4001', async () => {
    const b = await makeBridge(undefined, 100)
    const ws = open(b.getStatus().port!)
    expect(await closeCode(ws)).toBe(4001)
  })

  it('Origin errado é recusado', async () => {
    const b = await makeBridge()
    const ws = open(b.getStatus().port!, 'chrome-extension://outro')
    const err = await new Promise<Error>((r) => ws.once('error', r))
    expect(err.message).toMatch(/401/)
  })

  it('correlaciona respostas por id', async () => {
    const b = await makeBridge()
    const ws = await connect(b)
    const reqs: Array<{ id: number; method: string }> = []
    ws.on('message', (d) => reqs.push(JSON.parse(d.toString())))
    const p1 = b.call('a', { x: 1 })
    const p2 = b.call('b')
    await expect.poll(() => reqs.length).toBe(2)
    const [r1, r2] = reqs
    ws.send(JSON.stringify({ type: 'res', id: r2.id, ok: false, error: 'falhou b' }))
    ws.send(JSON.stringify({ type: 'res', id: r1.id, ok: true, result: { v: 'a' } }))
    await expect(p1).resolves.toEqual({ v: 'a' })
    await expect(p2).rejects.toThrow('falhou b')
    expect(r1.method).toBe('a')
  })

  it('timeout com mensagem exata', async () => {
    const b = await makeBridge()
    await connect(b)
    await expect(b.call('status', {}, 50)).rejects.toThrow(ERR_TIMEOUT)
  })

  it('sem conexão rejeita com mensagem exata', async () => {
    const b = await makeBridge()
    await expect(b.call('status')).rejects.toThrow(ERR_NOT_CONNECTED)
  })

  it('desconexão rejeita pendentes', async () => {
    const b = await makeBridge()
    const ws = await connect(b)
    const p = b.call('status')
    ws.close()
    await expect(p).rejects.toThrow(ERR_NOT_CONNECTED)
    await expect.poll(() => b.getStatus().connected).toBe(false)
  })

  it('nova conexão substitui a antiga', async () => {
    const b = await makeBridge()
    const old = await connect(b)
    const oldClosed = closeCode(old)
    const pending = b.call('status').catch((e: Error) => e.message)
    const fresh = await connect(b)
    await oldClosed
    expect(await pending).toBe(ERR_NOT_CONNECTED)
    expect(b.getStatus().connected).toBe(true)
    const m = nextMessage(fresh)
    const p = b.call('listTabs')
    const req = await m
    fresh.send(JSON.stringify({ type: 'res', id: req.id, ok: true, result: 1 }))
    await expect(p).resolves.toBe(1)
  })

  it('usa a próxima porta quando a primeira está ocupada', async () => {
    const blocker = createServer()
    blockers.push(blocker)
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    const first = (blocker.address() as { port: number }).port
    const second = await basePort()
    const b = await makeBridge([first, second])
    expect(b.getStatus().port).toBe(second)
  })
})
