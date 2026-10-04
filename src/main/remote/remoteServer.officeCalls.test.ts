import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { get, type IncomingMessage } from 'node:http'
import { OFFICE_BRIDGE_CONV, type OfficeCallEvent } from '../../shared/officeCall'
import { RemoteServer } from './remoteServer'

// Os chamados do escritório na ponte do celular, por HTTP de verdade (o SSE).

const server = new RemoteServer({ onInbound: () => {}, apkPath: () => 'C:/nonexistent.apk', wwwDir: () => 'C:/nonexistent/www' })
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

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Conecta no SSE e devolve o texto acumulado (e como fechar). */
async function connect(): Promise<{ text: () => string; close: () => void }> {
  let buf = ''
  const req = get(`${base}/api/events?token=${token}`)
  const res = await new Promise<IncomingMessage>((resolve) => req.on('response', resolve))
  res.on('data', (d) => (buf += d.toString()))
  return { text: () => buf, close: () => req.destroy() }
}

/** Os eventos `data:` do texto do SSE. */
const events = (text: string): Array<{ convId: string; event: { kind: string } & Record<string, unknown> }> =>
  text
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)))

const call = (id: string): OfficeCallEvent => ({ id, convId: 'c1', agente: 'Loja', projeto: 'loja', arquivo: 'mockups/vitrine.html', titulo: 'Vitrine nova', mensagem: 'dá uma olhada?', at: 1_000 })

describe('RemoteServer — chamados do escritório (office-call)', () => {
  it('office-call e office-call-resolved chegam a quem está conectado; quem conecta depois recebe a lista dos abertos', async () => {
    const a = await connect()
    server.officeCalls.call(call('k1'))
    server.officeCalls.call(call('k2'))
    await waitFor(() => events(a.text()).length >= 2)
    expect(events(a.text())[0]).toEqual({ convId: OFFICE_BRIDGE_CONV, event: { kind: 'office-call', ...call('k1') } })
    server.officeCalls.resolved({ id: 'k1', motivo: 'aberto' })
    server.officeCalls.resolved({ id: 'nunca-anunciado', motivo: 'cancelado' })
    await waitFor(() => events(a.text()).length >= 3)
    expect(events(a.text())[2]).toEqual({ convId: OFFICE_BRIDGE_CONV, event: { kind: 'office-call-resolved', id: 'k1', motivo: 'aberto' } })
    // Quem conecta agora: só o k2 aberto.
    const b = await connect()
    await waitFor(() => events(b.text()).length >= 1)
    expect(events(b.text())[0]).toEqual({ convId: OFFICE_BRIDGE_CONV, event: { kind: 'office-calls', calls: [call('k2')] } })
    server.officeCalls.resolved({ id: 'k2', motivo: 'respondido' })
    await waitFor(() => events(b.text()).length >= 2)
    expect(events(a.text()).filter((e) => e.event.kind === 'office-call-resolved')).toHaveLength(2)
    // Sem abertos, quem conecta não recebe lista nenhuma.
    const c = await connect()
    await new Promise((r) => setTimeout(r, 50))
    expect(events(c.text())).toEqual([])
    a.close()
    b.close()
    c.close()
  })
})
