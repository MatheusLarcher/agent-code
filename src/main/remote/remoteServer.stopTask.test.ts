import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { RemoteServer, type RemoteServerDeps } from './remoteServer'

/**
 * `POST /api/stop-task` do celular: os dois ids validados (texto, 1..200) e
 * entregues à dependência; a resposta diz se o SDK aceitou. Sem a dependência
 * ou com ela falhando, `ok: false` — nunca 500.
 */

const stops: Array<[string, string]> = []
let answer: () => Promise<boolean> = async () => true
const deps: RemoteServerDeps = {
  onInbound: () => undefined,
  apkPath: () => 'C:/nonexistent/agent-remote.apk',
  wwwDir: () => 'C:/nonexistent/www',
  onStopTask: (convId, taskId) => {
    stops.push([convId, taskId])
    return answer()
  }
}
const server = new RemoteServer(deps)

let base = ''
let token = ''

const post = (payload: unknown): Promise<{ status: number; json: { ok?: boolean; error?: string } }> =>
  new Promise((resolve, reject) => {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
    const req = request(
      `${base}/api/stop-task?token=${token}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: body ? JSON.parse(body) : {} }))
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })

beforeAll(async () => {
  const info = await server.start()
  base = `http://127.0.0.1:${info.port}`
  token = info.token
})
afterAll(async () => {
  await server.stop()
})

describe('RemoteServer — /api/stop-task', () => {
  it('sem os dois ids (ou com JSON quebrado): 400 e nada chega à dependência', async () => {
    expect((await post({})).status).toBe(400)
    expect((await post({ convId: 'c1' })).status).toBe(400)
    expect((await post({ convId: 'c1', taskId: 'x'.repeat(201) })).status).toBe(400)
    expect((await post('{')).status).toBe(400)
    expect(stops).toEqual([])
  })

  it('chama a dependência com os ids e devolve o que ela disse', async () => {
    answer = async () => true
    expect(await post({ convId: 'c1', taskId: 'b3k9x2' })).toEqual({ status: 200, json: { ok: true } })
    answer = async () => false
    expect((await post({ convId: 'c1', taskId: 'outra' })).json).toEqual({ ok: false })
    answer = async () => {
      throw new Error('sessão sumiu')
    }
    expect((await post({ convId: 'c1', taskId: 'mais-uma' })).json).toEqual({ ok: false })
    expect(stops).toEqual([
      ['c1', 'b3k9x2'],
      ['c1', 'outra'],
      ['c1', 'mais-uma']
    ])
  })

  it('PC sem a dependência: ok false', async () => {
    const original = deps.onStopTask
    deps.onStopTask = undefined
    try {
      expect(await post({ convId: 'c1', taskId: 't1' })).toEqual({ status: 200, json: { ok: false } })
    } finally {
      deps.onStopTask = original
    }
  })
})
