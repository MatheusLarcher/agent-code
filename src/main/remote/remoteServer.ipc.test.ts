import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { get, request, type IncomingMessage } from 'node:http'
import { RemoteServer } from './remoteServer'
import { AppIpcBridge } from './appIpcBridge'
import { Channels } from '../../shared/ipc'
import { OFFICE_BRIDGE_CONV } from '../../shared/officeCall'

// O POST /api/ipc e o aviso SSE do main (o Quadro e o SM no celular) por HTTP de verdade.

const bridge = new AppIpcBridge(() => {})
bridge.handle(Channels.boardList, async (_e, cwd: string) => ({ cwd, itens: [] }))
bridge.handle(Channels.boardMove, () => {
  throw new Error('cartão sumiu')
})
const server = new RemoteServer({
  onInbound: () => {},
  apkPath: () => 'C:/nonexistent/agent-remote.apk',
  wwwDir: () => 'C:/nonexistent/www',
  appIpc: bridge
})

let base = ''
let token = ''

beforeAll(async () => {
  const info = await server.start()
  token = info.token
  base = `http://127.0.0.1:${info.port}`
})

afterAll(async () => {
  await server.stop()
})

function post(path: string, payload: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
    const req = request(
      base + path,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: body ? JSON.parse(body) : null }))
      }
    )
    req.on('error', reject)
    req.end(data)
  })
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('POST /api/ipc', () => {
  it('401 sem token', async () => {
    const res = await post('/api/ipc', { channel: Channels.boardList, args: ['/proj'] })
    expect(res.status).toBe(401)
  })

  it('400 com canal fora da lista ou JSON ruim', async () => {
    expect((await post(`/api/ipc?token=${token}`, { channel: 'agent:send', args: [] })).status).toBe(400)
    expect((await post(`/api/ipc?token=${token}`, '{oops')).status).toBe(400)
  })

  it('200 com o resultado do listener', async () => {
    const res = await post(`/api/ipc?token=${token}`, { channel: Channels.boardList, args: ['/proj'] })
    expect(res).toEqual({ status: 200, json: { ok: true, result: { cwd: '/proj', itens: [] } } })
  })

  it('404 sem handler e 500 quando o handler lança', async () => {
    const missing = await post(`/api/ipc?token=${token}`, { channel: Channels.scrumPanel, args: [] })
    expect(missing.status).toBe(404)
    const failed = await post(`/api/ipc?token=${token}`, { channel: Channels.boardMove, args: ['b1', 'done'] })
    expect(failed).toEqual({ status: 500, json: { ok: false, error: 'cartão sumiu' } })
  })
})

describe('aviso do main no SSE', () => {
  it('boardChanged chega no envelope do escritório; canal fora da lista não', async () => {
    let buf = ''
    const req = get(`${base}/api/events?token=${token}`)
    const res = await new Promise<IncomingMessage>((resolve) => req.on('response', resolve))
    res.on('data', (d) => (buf += d.toString()))
    server.appIpcEvent('agent:event', { segredo: true })
    server.appIpcEvent(Channels.boardChanged, { projectId: 'p1' })
    await waitFor(() => buf.includes('"app-ipc"'))
    const line = buf.split('\n').find((l) => l.includes('"app-ipc"')) ?? ''
    expect(JSON.parse(line.slice('data: '.length))).toEqual({
      convId: OFFICE_BRIDGE_CONV,
      event: { kind: 'app-ipc', channel: Channels.boardChanged, payload: { projectId: 'p1' } }
    })
    expect(buf).not.toContain('segredo')
    req.destroy()
  })
})
