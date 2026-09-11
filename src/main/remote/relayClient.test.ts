import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, get as httpGet, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
// @ts-expect-error — JS puro do projeto irmão broker/ (sem tipos)
import { createBroker } from '../../../broker/src/broker.js'
import { RelayClient } from './relayClient'

let broker: ReturnType<typeof createBroker>
let brokerPort = 0
let local: Server
let localPort = 0
let relay: RelayClient

// RemoteServer "stub": responde como o bridge real (rota normal + SSE).
function startLocal(): Promise<void> {
  return new Promise((resolve) => {
    local = createServer((req, res) => {
      if ((req.url ?? '').startsWith('/api/events')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write('data: ping\n\n')
        return // fica aberto (streaming), como o /api/events real
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, url: req.url }))
    })
    local.listen(0, () => {
      localPort = (local.address() as AddressInfo).port
      resolve()
    })
  })
}

beforeAll(async () => {
  broker = createBroker({})
  await new Promise<void>((r) => broker.listen(0, r))
  brokerPort = (broker.server.address() as AddressInfo).port
  await startLocal()

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('relay não conectou')), 4000)
    relay = new RelayClient({
      brokerUrl: `ws://127.0.0.1:${brokerPort}/__relay`,
      getToken: () => 'tok-pc',
      getInstanceId: () => 'pc-teste',
      getPort: () => localPort,
      onStatus: (c) => {
        if (c) {
          clearTimeout(t)
          resolve()
        }
      }
    })
    relay.start()
  })
})

afterAll(async () => {
  relay.stop()
  await broker.close()
  await new Promise<void>((r) => local.close(() => r()))
})

function get(path: string): Promise<{ status: number; body: string; ctype?: string }> {
  return new Promise((resolve, reject) => {
    httpGet(`http://127.0.0.1:${brokerPort}${path}`, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, ctype: res.headers['content-type'] }))
    }).on('error', reject)
  })
}

function readSse(path: string): Promise<{ status: number; chunk: string }> {
  return new Promise((resolve, reject) => {
    const req = httpGet(`http://127.0.0.1:${brokerPort}${path}`, (res) => {
      res.on('data', (d) => {
        resolve({ status: res.statusCode ?? 0, chunk: d.toString() })
        req.destroy()
      })
    })
    req.on('error', () => {})
    setTimeout(() => reject(new Error('sse timeout')), 3000)
  })
}

describe('RelayClient — PC disca pro broker e repassa pro RemoteServer local', () => {
  it('conecta ao broker (status)', () => {
    expect(relay.isConnected()).toBe(true)
  })

  it('request do celular atravessa broker→relay→bridge local e volta', async () => {
    const r = await get('/api/state?token=tok-pc')
    expect(r.status).toBe(200)
    const j = JSON.parse(r.body)
    expect(j.ok).toBe(true)
    expect(j.url).toContain('token=tok-pc') // a url chega ao bridge com o token (auth)
  })

  it('SSE chega em streaming pelo relay', async () => {
    const r = await readSse('/api/events?token=tok-pc')
    expect(r.status).toBe(200)
    expect(r.chunk).toContain('ping')
  })

  it('token de PC não conectado → 503', async () => {
    const r = await get('/api/state?token=ninguem')
    expect(r.status).toBe(503)
  })

  it('segundo PC com o mesmo token (outra instalação) fica em "busy" — o primeiro continua atendendo', async () => {
    const states: string[] = []
    const second = new RelayClient({
      brokerUrl: `ws://127.0.0.1:${brokerPort}/__relay`,
      getToken: () => 'tok-pc',
      getInstanceId: () => 'outra-instalacao',
      getPort: () => localPort,
      onStatus: (_c, s) => states.push(s)
    })
    second.start()
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('sem busy')), 4000)
      const poll = setInterval(() => {
        if (second.getState() === 'busy') {
          clearTimeout(t)
          clearInterval(poll)
          resolve()
        }
      }, 20)
    })
    expect(second.isConnected()).toBe(false)
    expect(relay.isConnected()).toBe(true)
    const r = await get('/api/state?token=tok-pc')
    expect(r.status).toBe(200) // ainda roteado pro primeiro
    second.stop()
    expect(second.getState()).toBe('off')
  })
})
