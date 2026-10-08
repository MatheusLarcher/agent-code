// @vitest-environment node
import { promises as fs } from 'node:fs'
import { get, request, type IncomingMessage } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { RemoteConversationAction, RemoteStatePayload } from '../../shared/ipc'
import { PLANNING_BRIDGE_CONV } from '../../shared/planningRemote'
import { notifyPlanningChanged } from '../planning/planningEvents'
import { registerPlanningIpc } from '../planning/planningIpc'
import { importMedia } from '../planning/planningMedia'
import { createPlan, openPlan, saveCard, saveRoteiro } from '../planning/planningStore'
import { attachPlanningEvents } from './planningBridge'
import { RemoteServer } from './remoteServer'

// As rotas /api/planning/* pela ponte de verdade (HTTP + SSE), com o store real
// na raiz legada (<cwd>/docs/spec — sem setPlanningDataRoot nos testes).

const actions: RemoteConversationAction[] = []
const server = new RemoteServer({
  onInbound: () => {},
  onConversationAction: (a) => void actions.push(a),
  apkPath: () => 'C:/nonexistent.apk',
  wwwDir: () => 'C:/nonexistent/www'
})
let base = ''
let token = ''
let cwd = ''
let outside = ''

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

function publish(projects: string[]): void {
  const state: RemoteStatePayload = { conversations: [], projects }
  server.setState(state)
}

interface Res {
  status: number
  type: string
  body: Buffer
  json: () => any
}

function call(route: string, params: Record<string, string> = {}, body?: unknown): Promise<Res> {
  const qs = new URLSearchParams({ token, ...params }).toString()
  return new Promise((resolve, reject) => {
    const req = request(`${base}${route}?${qs}`, { method: body === undefined ? 'GET' : 'POST', agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: buf, json: () => JSON.parse(buf.toString()) })
      })
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
  })
}

beforeAll(async () => {
  const info = await server.start()
  token = info.token
  base = `http://127.0.0.1:${info.port}`
})
afterAll(async () => {
  await server.stop()
})

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-bridge-'))
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-bridge-out-'))
  actions.length = 0
  publish([cwd])
  await createPlan(cwd, 'plano-a', 'Checkout novo')
  const rev = (await openPlan(cwd, 'plano-a')).roteiro.rev ?? 0
  await saveRoteiro(cwd, 'plano-a', { titulo: 'Checkout novo', etapas: [{ id: 'e1', titulo: 'Base', status: 'concluida' }, { id: 'e2', titulo: 'Tela', status: 'pendente', estimativa: 30 }] }, rev)
  await saveCard(cwd, 'plano-a', { id: 'req-1', tipo: 'requisito', titulo: 'Pagar com Pix', etapa: 'e1', links: ['amb-1'], rev: 0, corpo: 'Ver [[amb-1]].\n' }, 0)
  await saveCard(cwd, 'plano-a', { id: 'amb-1', tipo: 'ambiguidade', titulo: 'Qual banco?', status: 'aberta', links: [], rev: 0, corpo: 'A ou B?\n' }, 0)
  await createPlan(cwd, 'plano-b', 'Vazio')
})

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

describe('GET /api/planning/list', () => {
  it('lista os planos do projeto com título, etapas e ambiguidades abertas', async () => {
    const res = await call('/api/planning/list', { cwd })
    expect(res.status).toBe(200)
    expect(res.json()).toEqual({
      ok: true,
      plans: [
        { slug: 'plano-a', titulo: 'Checkout novo', etapas: { total: 2, concluidas: 1, fonte: 'especificacao' }, cards: 2, ambiguidadesAbertas: 1 },
        { slug: 'plano-b', titulo: 'Vazio', etapas: { total: 0, concluidas: 0, fonte: 'especificacao' }, cards: 0, ambiguidadesAbertas: 0 }
      ]
    })
  })

  it('recusa projeto que o PC não conhece (403) e cwd inválido (400)', async () => {
    publish([])
    expect((await call('/api/planning/list', { cwd })).json()).toMatchObject({ ok: false, code: 'unknown_project' })
    expect((await call('/api/planning/list', { cwd })).status).toBe(403)
    publish(['relativo'])
    const rel = await call('/api/planning/list', { cwd: 'relativo' })
    expect(rel.status).toBe(400)
    expect(rel.json()).toMatchObject({ ok: false, code: 'invalid' })
    expect((await call('/api/planning/list')).status).toBe(400)
  })

  it('projeto conhecido cuja pasta sumiu → 404', async () => {
    const gone = path.join(outside, 'sumiu')
    publish([gone])
    expect((await call('/api/planning/list', { cwd: gone })).json()).toMatchObject({ ok: false, code: 'not_found' })
  })
})

describe('GET /api/planning/plan', () => {
  it('devolve roteiro + cards, sem layout do canvas nem pastas do PC', async () => {
    await importMedia(cwd, 'plano-a', { name: 'Tela.png', data: PNG }, { randomPrefix: () => 'abc123' })
    const res = await call('/api/planning/plan', { cwd, slug: 'plano-a' })
    expect(res.status).toBe(200)
    const { plan } = res.json()
    expect(Object.keys(plan).sort()).toEqual(['cards', 'invalid', 'media', 'roteiro', 'slug'])
    expect(plan.roteiro.etapas).toHaveLength(2)
    expect(plan.cards.map((c: { id: string }) => c.id).sort()).toEqual(['amb-1', 'req-1'])
    expect(plan.cards.find((c: { id: string }) => c.id === 'req-1')).toMatchObject({ corpo: 'Ver [[amb-1]].\n', etapa: 'e1' })
    expect(plan.media).toEqual([{ name: 'abc123-tela.png', kind: 'imagem', size: PNG.length, mediaType: 'image/png' }])
  })

  it('plano inexistente → 404; slug inválido → 400; projeto desconhecido → 403', async () => {
    expect((await call('/api/planning/plan', { cwd, slug: 'nao-existe' })).status).toBe(404)
    expect((await call('/api/planning/plan', { cwd, slug: '../plano-a' })).status).toBe(400)
    expect((await call('/api/planning/plan', { cwd, slug: 'plano-a', extra: '1' })).status).toBe(200)
    publish([])
    expect((await call('/api/planning/plan', { cwd, slug: 'plano-a' })).status).toBe(403)
  })
})

describe('GET /api/planning/media', () => {
  it('serve a imagem com o tipo dela', async () => {
    const m = await importMedia(cwd, 'plano-a', { name: 'Tela.png', data: PNG }, { randomPrefix: () => 'abc123' })
    const res = await call('/api/planning/media', { cwd, slug: 'plano-a', name: m.name })
    expect(res.status).toBe(200)
    expect(res.type).toBe('image/png')
    expect(res.body.equals(PNG)).toBe(true)
  })

  it('recusa nome com caminho, mídia que não é imagem e a que não existe', async () => {
    await importMedia(cwd, 'plano-a', { name: 'spec.pdf', data: Buffer.from('pdf') }, { randomPrefix: () => 'abc123' })
    expect((await call('/api/planning/media', { cwd, slug: 'plano-a', name: '../_roteiro.md' })).status).toBe(400)
    expect((await call('/api/planning/media', { cwd, slug: 'plano-a', name: 'a/b.png' })).status).toBe(400)
    expect((await call('/api/planning/media', { cwd, slug: 'plano-a', name: 'abc123-spec.pdf' })).status).toBe(400)
    expect((await call('/api/planning/media', { cwd, slug: 'plano-a', name: 'nao-existe.png' })).status).toBe(404)
    publish([])
    expect((await call('/api/planning/media', { cwd, slug: 'plano-a', name: 'x.png' })).status).toBe(403)
  })

  it('recusa caminho que sai da pasta do plano (midia/ como junção para fora)', async () => {
    await fs.writeFile(path.join(outside, 'segredo.png'), PNG)
    await fs.symlink(outside, path.join(cwd, 'docs', 'spec', 'plano-a', 'midia'), 'junction')
    const res = await call('/api/planning/media', { cwd, slug: 'plano-a', name: 'segredo.png' })
    expect(res.status).toBe(400)
    expect(res.body.equals(PNG)).toBe(false)
  })
})

describe('POST /api/planning/create', () => {
  it('vira a ação `plan` para o renderer e devolve o convId', async () => {
    const res = await call('/api/planning/create', {}, { cwd, pedido: '  quero um checkout  ' })
    expect(res.status).toBe(200)
    const { ok, convId } = res.json()
    expect(ok).toBe(true)
    expect(convId).toMatch(/^c-[0-9a-f]{12}$/)
    expect(actions).toEqual([{ type: 'plan', cwd, convId, pedido: 'quero um checkout' }])
  })

  it('recusa projeto desconhecido, corpo inválido e GET', async () => {
    expect((await call('/api/planning/create', {}, { cwd: path.join(outside, 'x'), pedido: 'a' })).status).toBe(403)
    expect((await call('/api/planning/create', {}, '{quebrado')).status).toBe(400)
    expect((await call('/api/planning/create', {}, { cwd, pedido: 'x'.repeat(20_001) })).status).toBe(400)
    expect((await call('/api/planning/create', {}, { cwd, extra: 1 })).status).toBe(400)
    expect((await call('/api/planning/create')).status).toBe(404)
    expect(actions).toEqual([])
  })
})

describe('planning-changed no SSE', () => {
  it('mudança de plano (agente → planningIpc) chega ao celular como evento leve', async () => {
    const ipc = registerPlanningIpc({
      handle: () => {},
      send: () => {},
      createWatcher: () => ({ watch: () => {}, unwatch: () => {}, closeAll: () => {} })
    })
    const detach = attachPlanningEvents(server)
    let buf = ''
    const req = get(`${base}/api/events?token=${token}`, { agent: false })
    const res = await new Promise<IncomingMessage>((resolve) => req.on('response', resolve))
    res.on('data', (d) => (buf += d.toString()))
    try {
      notifyPlanningChanged({ projectCwd: cwd, slug: 'plano-a' })
      const start = Date.now()
      while (!buf.includes('planning-changed') && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 10))
      const line = buf.split('\n\n').find((b) => b.includes('planning-changed'))
      expect(JSON.parse(String(line).slice(6))).toEqual({
        convId: PLANNING_BRIDGE_CONV,
        event: { kind: 'planning-changed', projectCwd: cwd, slug: 'plano-a' }
      })
    } finally {
      req.destroy()
      detach()
      ipc.close()
    }
  })
})
