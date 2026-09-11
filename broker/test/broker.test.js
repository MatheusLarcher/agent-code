import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { get as httpGet, request as httpRequest } from 'node:http'
import { WebSocket } from 'ws'
import { createBroker } from '../src/broker.js'

let broker
let port = 0
const sockets = []

beforeAll(async () => {
  broker = createBroker({})
  await new Promise((resolve) => broker.listen(0, resolve))
  port = broker.server.address().port
})

afterAll(async () => {
  for (const ws of sockets) {
    try {
      ws.close()
    } catch {
      /* ignore */
    }
  }
  await broker.close()
})

/** Conecta um "PC" fake: registra `token` e responde às requests via `onOpen`. */
function connectHost(token, onOpen) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__relay`)
    sockets.push(ws)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token })))
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'ready') resolve(ws)
      else if (msg.type === 'open') onOpen(ws, msg)
    })
  })
}

function reply(ws, rid, status, headers, bodyStr) {
  ws.send(JSON.stringify({ type: 'head', rid, status, headers }))
  if (bodyStr) ws.send(JSON.stringify({ type: 'data', rid, b64: Buffer.from(bodyStr).toString('base64') }))
  ws.send(JSON.stringify({ type: 'end', rid }))
}

function get(path) {
  return new Promise((resolve, reject) => {
    httpGet(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
    }).on('error', reject)
  })
}

/** Abre uma request SSE e resolve no primeiro chunk recebido. */
function readSse(path) {
  return new Promise((resolve, reject) => {
    const req = httpGet(`http://127.0.0.1:${port}${path}`, (res) => {
      res.on('data', (d) => {
        resolve({ status: res.statusCode, chunk: d.toString(), ctype: res.headers['content-type'] })
        req.destroy()
      })
    })
    req.on('error', () => {})
    setTimeout(() => reject(new Error('sse timeout')), 3000)
  })
}

describe('broker — roteamento por token', () => {
  it('sem token → 400', async () => {
    const r = await get('/api/state')
    expect(r.status).toBe(400)
  })

  it('token sem PC conectado → 503 (não vaza pra outro)', async () => {
    const r = await get('/api/state?token=naoexiste')
    expect(r.status).toBe(503)
  })

  it('PC conectado recebe a request e responde (round-trip), mantendo o ?token= na url', async () => {
    await connectHost('tok-A', (ws, msg) => reply(ws, msg.rid, 200, { 'content-type': 'application/json' }, JSON.stringify({ ok: true, url: msg.url, host: 'A' })))
    const r = await get('/api/state?token=tok-A')
    expect(r.status).toBe(200)
    const j = JSON.parse(r.body)
    expect(j.ok).toBe(true)
    expect(j.host).toBe('A')
    expect(j.url).toContain('token=tok-A') // o token original chega ao PC (auth do RemoteServer)
  })

  it('isolamento: cada token cai no seu próprio PC', async () => {
    await connectHost('tok-1', (ws, msg) => reply(ws, msg.rid, 200, {}, 'PC-UM'))
    await connectHost('tok-2', (ws, msg) => reply(ws, msg.rid, 200, {}, 'PC-DOIS'))
    const [r1, r2] = await Promise.all([get('/x?token=tok-1'), get('/x?token=tok-2')])
    expect(r1.body).toBe('PC-UM')
    expect(r2.body).toBe('PC-DOIS')
  })

  it('SSE: evento emitido no PC chega em streaming no celular', async () => {
    await connectHost('tok-sse', (ws, msg) => {
      ws.send(JSON.stringify({ type: 'head', rid: msg.rid, status: 200, headers: { 'content-type': 'text/event-stream' } }))
      ws.send(JSON.stringify({ type: 'data', rid: msg.rid, b64: Buffer.from('data: oi-sse\n\n').toString('base64') }))
      // não manda 'end' — fica streamando, como o /api/events real
    })
    const r = await readSse('/api/events?token=tok-sse')
    expect(r.status).toBe(200)
    expect(r.ctype).toContain('text/event-stream')
    expect(r.chunk).toContain('oi-sse')
  })

  it('POST com corpo é repassado ao PC', async () => {
    const received = []
    await connectHost('tok-post', (ws, msg) => {
      let body = ''
      const collect = (raw) => {
        const m = JSON.parse(raw.toString())
        if (m.rid !== msg.rid) return
        if (m.type === 'data') body += Buffer.from(m.b64, 'base64').toString()
        else if (m.type === 'end') {
          received.push(body)
          reply(ws, msg.rid, 200, {}, 'recebido')
          ws.off('message', collect)
        }
      }
      ws.on('message', collect)
    })
    const r = await new Promise((resolve, reject) => {
      const req = httpRequest(
        `http://127.0.0.1:${port}/api/send?token=tok-post`,
        { method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => {
          let b = ''
          res.on('data', (d) => (b += d))
          res.on('end', () => resolve({ status: res.statusCode, body: b }))
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify({ convId: 'c1', text: 'oi' }))
    })
    expect(r.body).toBe('recebido')
    expect(received[0]).toContain('"text":"oi"')
  })
})

/** Conecta um PC com identidade; resolve com {ws, outcome} onde outcome é 'ready' | 'busy' | 'denied'. */
function connectHostWithId(token, instanceId, onOpen) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__relay`)
    sockets.push(ws)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token, instanceId })))
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'ready' || msg.type === 'busy' || msg.type === 'denied') resolve({ ws, outcome: msg.type })
      else if (msg.type === 'open' && onOpen) onOpen(ws, msg)
    })
  })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

describe('broker — posse do token e conexões mortas', () => {
  it('o primeiro PC vence: outro PC (instanceId diferente) com o mesmo token recebe busy e o celular segue no primeiro', async () => {
    const a = await connectHostWithId('tok-dono', 'pc-A', (ws, msg) => reply(ws, msg.rid, 200, {}, 'sou-A'))
    expect(a.outcome).toBe('ready')
    const b = await connectHostWithId('tok-dono', 'pc-B', (ws, msg) => reply(ws, msg.rid, 200, {}, 'sou-B'))
    expect(b.outcome).toBe('busy')
    const r = await get('/x?token=tok-dono')
    expect(r.body).toBe('sou-A')
  })

  it('o MESMO PC reconectando (mesmo instanceId) substitui a conexão antiga na hora', async () => {
    const first = await connectHostWithId('tok-mesmo', 'pc-X', (ws, msg) => reply(ws, msg.rid, 200, {}, 'velho'))
    expect(first.outcome).toBe('ready')
    const second = await connectHostWithId('tok-mesmo', 'pc-X', (ws, msg) => reply(ws, msg.rid, 200, {}, 'novo'))
    expect(second.outcome).toBe('ready')
    const r = await get('/x?token=tok-mesmo')
    expect(r.body).toBe('novo')
    // A conexão velha foi encerrada pelo broker.
    await wait(50)
    expect(first.ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('PC mudo além do limite é derrubado no sweep → 503 depois, e o token fica livre para outro PC', async () => {
    const a = await connectHostWithId('tok-mudo', 'pc-M1', (ws, msg) => reply(ws, msg.rid, 200, {}, 'M1'))
    expect(a.outcome).toBe('ready')
    // Simula silêncio: avança o relógio além de HOST_DEAD_MS só para este host.
    const host = broker.hosts.get('tok-mudo')
    host.lastSeen = Date.now() - 10 * 60_000
    broker.sweep()
    expect(broker.hosts.has('tok-mudo')).toBe(false)
    const r = await get('/x?token=tok-mudo')
    expect(r.status).toBe(503)
    const b = await connectHostWithId('tok-mudo', 'pc-M2', (ws, msg) => reply(ws, msg.rid, 200, {}, 'M2'))
    expect(b.outcome).toBe('ready')
    expect((await get('/x?token=tok-mudo')).body).toBe('M2')
  })

  it('PC que não responde a request a tempo → 504 no celular (em vez de pendurar)', async () => {
    const slow = createBroker({ headTimeoutMs: 150 })
    await new Promise((resolve) => slow.listen(0, resolve))
    const slowPort = slow.server.address().port
    const ws = new WebSocket(`ws://127.0.0.1:${slowPort}/__relay`)
    sockets.push(ws)
    await new Promise((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: 'tok-lento' })))
      ws.on('message', (raw) => { if (JSON.parse(raw.toString()).type === 'ready') resolve() })
    })
    const r = await new Promise((resolve, reject) => {
      httpGet(`http://127.0.0.1:${slowPort}/x?token=tok-lento`, (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => resolve({ status: res.statusCode, body }))
      }).on('error', reject)
    })
    expect(r.status).toBe(504)
    await slow.close()
  })

  it('ping de aplicação do PC recebe pong', async () => {
    const a = await connectHostWithId('tok-ping', 'pc-P')
    const pong = await new Promise((resolve) => {
      a.ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'pong') resolve(m) })
      a.ws.send(JSON.stringify({ type: 'ping' }))
    })
    expect(pong.type).toBe('pong')
  })
})
