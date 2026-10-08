import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { get } from 'node:http'
import { RemoteServer } from './remoteServer'

// Sem banco, o histórico do celular não pode ficar pendurado: a conversa que está na
// fila de gravação sai na hora; a que só está no banco volta 503 (o celular tenta depois).

const server = new RemoteServer({
  onInbound: () => undefined,
  apkPath: () => 'C:/nonexistent/agent-remote.apk',
  wwwDir: () => 'C:/nonexistent/www',
  host: () => '127.0.0.1',
  messageSource: {
    snapshot: (id) => (id === 'na-fila' ? [{ kind: 'user', id: 'u1', text: 'pendente' }] : null),
    load: () => Promise.reject(new Error('banco indisponível'))
  }
})

let base = ''
let token = ''

beforeAll(async () => {
  const info = await server.start()
  token = info.token
  base = `http://127.0.0.1:${info.port}`
  const light = (id: string) => ({ id, title: id, cwd: '/proj', busy: false, connected: false, updatedAt: 1, messageCount: 1 })
  server.setState({ conversations: [light('na-fila'), light('so-no-banco')] })
})

afterAll(async () => {
  await server.stop()
})

function getJson(path: string): Promise<{ status: number; json: { messages?: unknown[]; error?: string } }> {
  return new Promise((resolve, reject) => {
    get(base + path, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: body ? JSON.parse(body) : {} }))
    }).on('error', reject)
  })
}

describe('RemoteServer — histórico com o banco fora do ar', () => {
  it('a conversa da fila sai na hora; a que só está no banco volta 503 "banco indisponível" sem esperar', async () => {
    const queued = await getJson(`/api/history?token=${token}&conv=na-fila`)
    expect(queued.status).toBe(200)
    expect(queued.json.messages).toEqual([{ kind: 'user', id: 'u1', text: 'pendente' }])
    const started = Date.now()
    const missing = await getJson(`/api/history?token=${token}&conv=so-no-banco`)
    expect(missing.status).toBe(503)
    expect(missing.json.error).toBe('banco indisponível')
    expect(Date.now() - started).toBeLessThan(1_000)
    const window = await getJson(`/api/history-window?token=${token}&conv=so-no-banco&message=u1`)
    expect(window.status).toBe(503)
  })
})
