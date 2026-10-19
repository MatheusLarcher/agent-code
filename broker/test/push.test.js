import { describe, it, expect, afterEach } from 'vitest'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { WebSocket } from 'ws'
import { createBroker } from '../src/broker.js'
import { createFcm, parseServiceAccount } from '../src/fcm.js'

// Push no celular: o PC (já registrado no relay) pede, o broker envia pelo FCM v1.

const TOKEN_APARELHO = 'fcm-token-do-celular-0123456789abcdef:APA91b'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const SA = {
  project_id: 'agent-code-larchertech',
  client_email: 'push@agent-code-larchertech.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token'
}

let broker = null
const sockets = []
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate()
  if (broker) await broker.close()
  broker = null
})

async function start(opts) {
  broker = createBroker(opts)
  await new Promise((resolve) => broker.listen(0, resolve))
  return broker.server.address().port
}

/** Um "PC" que fez hello; `frames` acumula o que o broker manda. */
function host(port, token = 'pc-token') {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__relay`)
    sockets.push(ws)
    const frames = []
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token })))
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      frames.push(msg)
      if (msg.type === 'ready') resolve({ ws, frames })
    })
  })
}

function nextResult(h, id) {
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      const found = h.frames.find((f) => f.type === 'push-result' && f.id === id)
      if (found) {
        clearInterval(tick)
        resolve(found)
      }
    }, 5)
  })
}

const pedido = (id, extra = {}) => JSON.stringify({ type: 'push', id, token: TOKEN_APARELHO, title: 'Passagem', body: 'Bateu: R$ 2.890', data: { convId: 'c1' }, ...extra })

describe('broker — push pelo FCM', () => {
  it('PC registrado: o FCM falso recebe o corpo e o cabeçalho certos e o PC recebe o resultado', async () => {
    const calls = []
    const fcm = { send: async (m) => (calls.push(m), { ok: true, status: 200 }) }
    const lines = []
    const port = await start({ fcm, log: (l) => lines.push(l) })
    const h = await host(port)
    h.ws.send(pedido('p1'))
    expect(await nextResult(h, 'p1')).toEqual({ type: 'push-result', id: 'p1', ok: true, status: 200 })
    expect(calls).toEqual([{ token: TOKEN_APARELHO, title: 'Passagem', body: 'Bateu: R$ 2.890', data: { convId: 'c1' } }])
    expect(lines).toEqual(['[broker] push FCM 200'])
    expect(lines.join(' ')).not.toContain(TOKEN_APARELHO)
  })

  it('frame de push sem hello antes (token desconhecido): fecha o socket e não envia', async () => {
    const calls = []
    const port = await start({ fcm: { send: async (m) => (calls.push(m), { ok: true, status: 200 }) } })
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__relay`)
    sockets.push(ws)
    const closed = new Promise((resolve) => ws.on('close', resolve))
    ws.on('open', () => ws.send(pedido('x')))
    await closed
    expect(calls).toHaveLength(0)
    expect(broker.stats().hosts).toBe(0)
  })

  it('limite por minuto por PC: o excedente volta 429 sem chamar o FCM; passa o minuto, libera', async () => {
    let t = 1_000_000
    const calls = []
    const port = await start({ fcm: { send: async (m) => (calls.push(m), { ok: true, status: 200 }) }, pushPerMinute: 2, now: () => t })
    const h = await host(port)
    h.ws.send(pedido('a'))
    await nextResult(h, 'a')
    h.ws.send(pedido('b'))
    await nextResult(h, 'b')
    h.ws.send(pedido('c'))
    expect(await nextResult(h, 'c')).toMatchObject({ ok: false, status: 429, error: 'limite' })
    expect(calls).toHaveLength(2)
    t += 61_000
    h.ws.send(pedido('d'))
    expect(await nextResult(h, 'd')).toMatchObject({ ok: true })
  })

  it('erro do FCM volta ao PC; pedido inválido e FCM desligado também respondem', async () => {
    const port = await start({ fcm: { send: async () => ({ ok: false, status: 404, error: 'UNREGISTERED' }) } })
    const h = await host(port)
    h.ws.send(pedido('e'))
    expect(await nextResult(h, 'e')).toEqual({ type: 'push-result', id: 'e', ok: false, status: 404, error: 'UNREGISTERED' })
    h.ws.send(pedido('f', { token: 'curto' }))
    expect(await nextResult(h, 'f')).toMatchObject({ ok: false, status: 400 })
    await broker.close()
    const port2 = await start({})
    const h2 = await host(port2)
    h2.ws.send(pedido('g'))
    expect(await nextResult(h2, 'g')).toMatchObject({ ok: false, status: 503, error: 'fcm-desligado' })
  })
})

describe('fcm.js — HTTP v1', () => {
  function fakeFetch(responses) {
    const calls = []
    const impl = async (url, init) => {
      calls.push({ url, init })
      const r = responses.shift()
      return { ok: r.status < 300, status: r.status, json: async () => r.json }
    }
    return { calls, impl }
  }

  it('troca o JWT RS256 por access token, guarda em cache e manda messages:send com Bearer', async () => {
    const f = fakeFetch([
      { status: 200, json: { access_token: 'ya29.token', expires_in: 3600 } },
      { status: 200, json: { name: 'projects/x/messages/1' } },
      { status: 200, json: { name: 'projects/x/messages/2' } }
    ])
    const fcm = createFcm({ serviceAccount: SA, fetchImpl: f.impl, now: () => 1_700_000_000_000 })
    expect(await fcm.send({ token: TOKEN_APARELHO, title: 'Lembrete', body: 'Beber água', data: { convId: 'c9', n: 3 } })).toEqual({ ok: true, status: 200 })
    await fcm.send({ token: TOKEN_APARELHO, title: 'Outro', body: '' })
    expect(f.calls).toHaveLength(3) // um token OAuth só para dois envios

    const oauth = f.calls[0]
    expect(oauth.url).toBe('https://oauth2.googleapis.com/token')
    const form = new URLSearchParams(oauth.init.body)
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const [head, claims, sig] = form.get('assertion').split('.')
    expect(JSON.parse(Buffer.from(head, 'base64url'))).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(claims, 'base64url'))).toMatchObject({
      iss: SA.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: SA.token_uri, iat: 1_700_000_000, exp: 1_700_003_600
    })
    const v = createVerify('RSA-SHA256')
    v.update(`${head}.${claims}`)
    expect(v.verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true)

    const send = f.calls[1]
    expect(send.url).toBe('https://fcm.googleapis.com/v1/projects/agent-code-larchertech/messages:send')
    expect(send.init.headers.authorization).toBe('Bearer ya29.token')
    expect(JSON.parse(send.init.body)).toEqual({
      message: {
        token: TOKEN_APARELHO,
        notification: { title: 'Lembrete', body: 'Beber água' },
        data: { convId: 'c9', n: '3' },
        android: { priority: 'HIGH', notification: { channel_id: 'avisos' } }
      }
    })
  })

  it('erro do FCM devolve status e código; OAuth recusado vira erro sem lançar', async () => {
    const f = fakeFetch([
      { status: 200, json: { access_token: 't', expires_in: 3600 } },
      { status: 404, json: { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } } }
    ])
    expect(await createFcm({ serviceAccount: SA, fetchImpl: f.impl }).send({ token: TOKEN_APARELHO, title: 'x', body: 'y' })).toEqual({ ok: false, status: 404, error: 'UNREGISTERED' })
    const recusado = fakeFetch([{ status: 400, json: { error: 'invalid_grant' } }])
    expect(await createFcm({ serviceAccount: SA, fetchImpl: recusado.impl }).send({ token: TOKEN_APARELHO, title: 'x', body: 'y' })).toEqual({ ok: false, status: 400, error: 'oauth' })
  })

  it('parseServiceAccount aceita o JSON do console e recusa o incompleto', () => {
    expect(parseServiceAccount(JSON.stringify(SA))?.project_id).toBe('agent-code-larchertech')
    expect(parseServiceAccount('{"client_email":"a"}')).toBeNull()
    expect(parseServiceAccount('não é json')).toBeNull()
    expect(parseServiceAccount('')).toBeNull()
  })
})
