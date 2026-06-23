import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { get, request, type IncomingMessage } from 'node:http'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RemoteServer } from './remoteServer'
import type { RemoteConversation } from '../../shared/ipc'

// Drive the LAN bridge over real HTTP (node:http, not jsdom fetch) so we verify
// auth, the JSON routes and the live SSE stream end‑to‑end.

const inbound: Array<{ convId: string; text: string }> = []
const server = new RemoteServer({
  onInbound: (convId, text) => inbound.push({ convId, text }),
  apkPath: () => 'C:/nonexistent/agent-remote.apk',
  wwwDir: () => 'C:/nonexistent/www'
})

let base = ''
let token = ''
let filePath = ''

beforeAll(async () => {
  const info = await server.start()
  token = info.token
  base = `http://127.0.0.1:${info.port}`
  // A real file "written" by the agent (referenced via a Write tool-use) so the
  // /api/file download allowlist accepts it.
  const dir = mkdtempSync(join(tmpdir(), 'agent-remote-'))
  filePath = join(dir, 'relatorio.pdf')
  writeFileSync(filePath, 'conteúdo do arquivo gerado')
  // A source file written during work must NOT be downloadable.
  const srcPath = join(dir, 'codigo.ts')
  writeFileSync(srcPath, 'export const x = 1')
  const conv: RemoteConversation = {
    id: 'c1',
    title: 'Conversa',
    cwd: '/proj',
    busy: false,
    connected: true,
    updatedAt: 2,
    messages: [
      { kind: 'user', id: 'u1', text: 'oi' },
      {
        kind: 'tool-use',
        id: 't1',
        name: 'Write',
        input: { file_path: filePath, content: 'x' },
        parentToolUseId: null
      },
      {
        kind: 'tool-use',
        id: 't2',
        name: 'Write',
        input: { file_path: srcPath, content: 'export const x = 1' },
        parentToolUseId: null
      }
    ]
  }
  server.setState({ conversations: [conv] })
})

afterAll(async () => {
  await server.stop()
})

function getJson(path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    get(base + path, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: body ? JSON.parse(body) : null }))
    }).on('error', reject)
  })
}

function postJson(path: string, payload: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload)
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
    req.write(data)
    req.end()
  })
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('RemoteServer — ponte LAN', () => {
  it('exige token nas rotas /api', async () => {
    const r = await getJson('/api/state')
    expect(r.status).toBe(401)
  })

  it('/api/state lista conversas (resumo, sem mensagens)', async () => {
    const r = await getJson(`/api/state?token=${token}`)
    expect(r.status).toBe(200)
    const convs = (r.json as { conversations: Array<{ id: string; messageCount: number; messages?: unknown }> }).conversations
    expect(convs).toHaveLength(1)
    expect(convs[0].id).toBe('c1')
    expect(convs[0].messageCount).toBe(3)
    expect(convs[0].messages).toBeUndefined()
  })

  it('/api/history devolve as mensagens da conversa', async () => {
    const r = await getJson(`/api/history?token=${token}&conv=c1`)
    expect(r.status).toBe(200)
    const msgs = (r.json as { messages: Array<{ text: string }> }).messages
    expect(msgs).toHaveLength(3)
    expect(msgs[0].text).toBe('oi')
  })

  it('POST /api/send encaminha o comando via onInbound', async () => {
    const r = await postJson(`/api/send?token=${token}`, { convId: 'c1', text: 'rode os testes' })
    expect(r.status).toBe(200)
    expect(inbound).toContainEqual({ convId: 'c1', text: 'rode os testes' })
  })

  it('POST /api/send sem token é rejeitado (401)', async () => {
    const r = await postJson('/api/send', { convId: 'c1', text: 'oi' })
    expect(r.status).toBe(401)
  })

  it('POST /api/send valida campos obrigatórios', async () => {
    const r = await postJson(`/api/send?token=${token}`, { convId: 'c1' })
    expect(r.status).toBe(400)
  })

  it('/api/file baixa um arquivo criado pelo agente', async () => {
    const r = await new Promise<{ status: number; body: string; disp: string }>((resolve, reject) => {
      get(`${base}/api/file?token=${token}&path=${encodeURIComponent(filePath)}`, (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            disp: String(res.headers['content-disposition'] ?? '')
          })
        )
      }).on('error', reject)
    })
    expect(r.status).toBe(200)
    expect(r.body).toBe('conteúdo do arquivo gerado')
    expect(r.disp).toContain('relatorio.pdf')
  })

  it('/api/file recusa um arquivo de código (não é entregável)', async () => {
    const srcPath = join(filePath, '..', 'codigo.ts')
    const status = await new Promise<number>((resolve, reject) => {
      get(`${base}/api/file?token=${token}&path=${encodeURIComponent(srcPath)}`, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }).on('error', reject)
    })
    expect(status).toBe(403)
  })

  it('/api/file recusa caminho fora da allowlist (403)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      get(`${base}/api/file?token=${token}&path=${encodeURIComponent('C:/Windows/system32/secret.txt')}`, (res) => {
        res.resume() // drain so the socket closes
        resolve(res.statusCode ?? 0)
      }).on('error', reject)
    })
    expect(status).toBe(403)
  })

  it('broadcast chega ao cliente SSE conectado', async () => {
    let buf = ''
    const req = get(`${base}/api/events?token=${token}`)
    const res = await new Promise<IncomingMessage>((resolve) => req.on('response', resolve))
    res.on('data', (d) => (buf += d.toString()))
    // The SSE client is registered synchronously while handling the request, so
    // once we have the response headers the broadcast is guaranteed delivered.
    server.broadcast('c1', { kind: 'status', id: 's1', text: 'compilando' })
    await waitFor(() => buf.includes('compilando'))
    expect(buf).toContain('"convId":"c1"')
    expect(buf).toContain('"text":"compilando"')
    req.destroy()
  })
})
