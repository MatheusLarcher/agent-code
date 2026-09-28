import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Channels } from '../../shared/ipc'
import { registerPlanningIpc, type PlanningIpcListener } from './planningIpc'

/** _handoff/enviados.json pelos canais planning:* (store e disco reais, vigia falsa). */

let cwd: string
let handlers: Map<string, PlanningIpcListener>
let sent: { channel: string; payload: unknown }[]

function setup(): void {
  registerPlanningIpc({
    handle: (channel, listener) => void handlers.set(channel, listener),
    send: (channel, payload) => void sent.push({ channel, payload }),
    createWatcher: () => ({ watch() {}, unwatch() {}, revive() {}, closeAll() {} })
  })
}

async function call(channel: string, payload: unknown): Promise<any> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`sem handler: ${channel}`)
  return fn({ sender: { id: 1 } }, payload)
}

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-sent-'))
  handlers = new Map()
  sent = []
})

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true })
})

describe('planning:markHandoffsSent / enviados.json', () => {
  it('enviados: markHandoffsSent grava enviados.json (upsert por nome) e listHandoffs devolve os registros', async () => {
    setup()
    const ref = { projectCwd: cwd, slug: 'p' }
    await call(Channels.planningCreate, { ...ref, titulo: 'P' })
    const a = (await call(Channels.planningWriteHandoff, { ...ref, conteudo: '# A\n' })).name
    const b = (await call(Channels.planningWriteHandoff, { ...ref, conteudo: '# B\n' })).name

    const res = await call(Channels.planningMarkHandoffsSent, {
      ...ref,
      entries: [
        { nome: a, conversaId: 'c1', conversaTitulo: 'Implementação: P' },
        { nome: b, marcadoManualmente: true }
      ]
    })
    expect(res.ok).toBe(true)
    expect(res.sent).toEqual([
      { nome: a, enviadoEm: expect.any(String), conversaId: 'c1', conversaTitulo: 'Implementação: P' },
      { nome: b, enviadoEm: expect.any(String), marcadoManualmente: true }
    ])
    // O novo registro do mesmo nome substitui o anterior.
    await call(Channels.planningMarkHandoffsSent, { ...ref, entries: [{ nome: b, substituidoPor: '2026-01-01-09.md' }] })
    const listed = await call(Channels.planningListHandoffs, ref)
    expect(listed.handoffs.map((h: { name: string }) => h.name)).toEqual([a, b]) // enviados.json não é prompt
    expect(listed.sent.map((e: { nome: string }) => e.nome)).toEqual([a, b])
    expect(listed.sent[1]).toEqual({ nome: b, enviadoEm: expect.any(String), substituidoPor: '2026-01-01-09.md' })
    expect(listed.sentError).toBeUndefined()

    // Gravação atômica: nenhum .tmp sobra em _handoff/.
    const dir = path.join(cwd, 'docs', 'spec', 'p', '_handoff')
    expect((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect(JSON.parse(await fs.readFile(path.join(dir, 'enviados.json'), 'utf8'))).toHaveLength(2)
    expect(sent).toEqual([])
  })

  it('enviados: marcas em paralelo não se sobrescrevem (fila do arquivo)', async () => {
    setup()
    const ref = { projectCwd: cwd, slug: 'p' }
    await call(Channels.planningCreate, { ...ref, titulo: 'P' })
    await Promise.all(
      ['a.md', 'b.md', 'c.md', 'd.md'].map((nome) =>
        call(Channels.planningMarkHandoffsSent, { ...ref, entries: [{ nome, marcadoManualmente: true }] })
      )
    )
    const listed = await call(Channels.planningListHandoffs, ref)
    expect(listed.sent.map((e: { nome: string }) => e.nome).sort()).toEqual(['a.md', 'b.md', 'c.md', 'd.md'])
  })

  it('enviados: enviados.json ilegível vale como ausente, com sentError; gravar por cima guarda o ilegível', async () => {
    setup()
    const ref = { projectCwd: cwd, slug: 'p' }
    await call(Channels.planningCreate, { ...ref, titulo: 'P' })
    const dir = path.join(cwd, 'docs', 'spec', 'p', '_handoff')
    await fs.mkdir(dir, { recursive: true })
    for (const bad of ['{ quebrado', '{"nome":"x.md"}', '[{"nome":"../fora.md","enviadoEm":"x"}]']) {
      await fs.writeFile(path.join(dir, 'enviados.json'), bad, 'utf8')
      const listed = await call(Channels.planningListHandoffs, ref)
      expect(listed).toMatchObject({ ok: true, handoffs: [], sent: [], sentError: expect.stringContaining('enviados.json') })
    }
    const res = await call(Channels.planningMarkHandoffsSent, { ...ref, entries: [{ nome: 'x.md', marcadoManualmente: true }] })
    expect(res.sent.map((e: { nome: string }) => e.nome)).toEqual(['x.md'])
    expect((await fs.readdir(dir)).some((n) => n.startsWith('enviados.json.ilegivel-'))).toBe(true)
    expect((await call(Channels.planningListHandoffs, ref)).sentError).toBeUndefined()
  })

  it('enviados: payload inválido e plano inexistente não gravam nada', async () => {
    setup()
    const ref = { projectCwd: cwd, slug: 'p' }
    await call(Channels.planningCreate, { ...ref, titulo: 'P' })
    const bad: unknown[] = [
      { ...ref },
      { ...ref, entries: [] },
      { ...ref, entries: [{ nome: 'a.md' }] }, // nenhum dos três casos
      { ...ref, entries: [{ nome: '../a.md', marcadoManualmente: true }] },
      { ...ref, entries: [{ nome: 'sub/a.md', marcadoManualmente: true }] },
      { ...ref, entries: [{ nome: 'a.txt', marcadoManualmente: true }] },
      { ...ref, entries: [{ nome: 'a.md', marcadoManualmente: false }] },
      { ...ref, entries: [{ nome: 'a.md', conversaId: 'c1' }] }, // sem título
      { ...ref, entries: [{ nome: 'a.md', substituidoPor: '..\\b.md' }] },
      { ...ref, entries: [{ nome: 'a.md', marcadoManualmente: true, extra: 1 }] },
      { ...ref, entries: Array.from({ length: 201 }, (_, i) => ({ nome: `${i}.md`, marcadoManualmente: true })) },
      { ...ref, entries: [{ nome: 'a.md', marcadoManualmente: true }], extra: 1 }
    ]
    for (const payload of bad) {
      expect(await call(Channels.planningMarkHandoffsSent, payload)).toMatchObject({ ok: false, code: 'invalid' })
    }
    expect(
      await call(Channels.planningMarkHandoffsSent, {
        projectCwd: cwd,
        slug: 'nada',
        entries: [{ nome: 'a.md', marcadoManualmente: true }]
      })
    ).toMatchObject({ ok: false, code: 'not_found' })
    await expect(fs.stat(path.join(cwd, 'docs', 'spec', 'p', '_handoff'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(cwd, 'docs', 'spec', 'nada'))).rejects.toMatchObject({ code: 'ENOENT' })
  })


  it('enviados: nome fora do padrão AAAA-MM-DD-NN ("Prompt final.md") também é registrado', async () => {
    setup()
    const ref = { projectCwd: cwd, slug: 'p' }
    await call(Channels.planningCreate, { ...ref, titulo: 'P' })
    const res = await call(Channels.planningMarkHandoffsSent, {
      ...ref,
      entries: [{ nome: 'Prompt final.md', conversaId: 'c1', conversaTitulo: 'Implementação: P' }]
    })
    expect(res).toMatchObject({ ok: true, sent: [{ nome: 'Prompt final.md', conversaId: 'c1' }] })
  })
})
