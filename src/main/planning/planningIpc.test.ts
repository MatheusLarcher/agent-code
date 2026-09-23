import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Channels, type PlanningCardDto } from '../../shared/ipc'
import { registerPlanningIpc, toPlanningFailure, type PlanningIpcListener, type PlanningStoreApi } from './planningIpc'
import type { PlanningChange } from './planningWatcher'
import * as realStore from './planningStore'

const PLANNING_CHANNELS = [
  Channels.planningList,
  Channels.planningCreate,
  Channels.planningOpen,
  Channels.planningClose,
  Channels.planningSaveCard,
  Channels.planningDeleteCard,
  Channels.planningSaveRoteiro,
  Channels.planningSaveLayout,
  Channels.planningListHandoffs,
  Channels.planningWriteHandoff
]

function fakeWatcher(): {
  calls: string[]
  emit: (c: PlanningChange) => void
  create: (onChange: (c: PlanningChange) => void) => {
    watch(cwd: string, slug: string): void
    unwatch(cwd: string, slug: string): void
    revive(cwd: string, slug: string): void
    closeAll(): void
  }
} {
  const calls: string[] = []
  let onChange: (c: PlanningChange) => void = () => {}
  return {
    calls,
    emit: (c) => onChange(c),
    create: (cb) => {
      onChange = cb
      return {
        watch: (_cwd, slug) => void calls.push(`watch:${slug}`),
        unwatch: (_cwd, slug) => void calls.push(`unwatch:${slug}`),
        revive: (_cwd, slug) => void calls.push(`revive:${slug}`),
        closeAll: () => void calls.push('closeAll')
      }
    }
  }
}

const card = (over: Partial<PlanningCardDto> = {}): PlanningCardDto => ({
  id: 'req-1',
  tipo: 'requisito',
  titulo: 'Requisito',
  links: [],
  rev: 0,
  corpo: 'corpo\n',
  ...over
})

let cwd: string
let handlers: Map<string, PlanningIpcListener>
let sent: { channel: string; payload: unknown }[]
let w: ReturnType<typeof fakeWatcher>

function setup(store?: PlanningStoreApi): ReturnType<typeof registerPlanningIpc> {
  return registerPlanningIpc({
    handle: (channel, listener) => void handlers.set(channel, listener),
    send: (channel, payload) => void sent.push({ channel, payload }),
    createWatcher: w.create,
    ...(store ? { store } : {})
  })
}

/** Invoca como o ipcMain faria; `sender` simula a janela que chamou. */
async function call(channel: string, payload: unknown, sender = 1): Promise<any> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`sem handler: ${channel}`)
  return fn({ sender: { id: sender } }, payload)
}

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-ipc-'))
  handlers = new Map()
  sent = []
  w = fakeWatcher()
})

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true })
})

describe('registerPlanningIpc', () => {
  it('registra os dez canais planning:*', () => {
    setup()
    expect([...handlers.keys()].sort()).toEqual([...PLANNING_CHANNELS].sort())
    expect(PLANNING_CHANNELS).toContain('planning:saveCard')
    expect(Channels.planningChanged).toBe('planning:changed')
  })

  it('ciclo completo com o store real devolve { ok: true, ... }', async () => {
    setup()
    const ref = { projectCwd: cwd, slug: 'checkout' }
    const created = await call(Channels.planningCreate, { ...ref, titulo: 'Checkout' })
    expect(created).toMatchObject({ ok: true, plan: { slug: 'checkout', roteiro: { rev: 1 }, cards: [], invalid: [] } })
    expect(await call(Channels.planningList, { projectCwd: cwd })).toEqual({ ok: true, slugs: ['checkout'] })

    const saved = await call(Channels.planningSaveCard, { ...ref, card: card(), expectedRev: 0 })
    expect(saved).toEqual({ ok: true, card: { ...card(), rev: 1 } })
    const roteiro = { titulo: 'Checkout', etapas: [{ id: 'e1', titulo: 'Req', status: 'pendente' }] }
    expect(await call(Channels.planningSaveRoteiro, { ...ref, roteiro, expectedRev: 1 })).toEqual({
      ok: true,
      roteiro: { ...roteiro, rev: 2 }
    })
    const layout = { positions: { 'req-1': { x: 1, y: 2 } }, viewport: { x: 0, y: 0, zoom: 1 } }
    expect(await call(Channels.planningSaveLayout, { ...ref, layout })).toEqual({ ok: true })

    const opened = await call(Channels.planningOpen, ref)
    expect(opened).toEqual({
      ok: true,
      plan: { slug: 'checkout', roteiro: { ...roteiro, rev: 2 }, cards: [{ ...card(), rev: 1 }], layout, invalid: [] }
    })
    expect(await call(Channels.planningDeleteCard, { ...ref, id: 'req-1', expectedRev: 1 })).toEqual({ ok: true })
    expect((await call(Channels.planningOpen, ref)).plan.cards).toEqual([])
  })

  it('rev desatualizado vira rev_conflict com o card atual', async () => {
    setup()
    const ref = { projectCwd: cwd, slug: 'p' }
    await call(Channels.planningCreate, { ...ref, titulo: 'P' })
    await call(Channels.planningSaveCard, { ...ref, card: card(), expectedRev: 0 })
    await call(Channels.planningSaveCard, { ...ref, card: card({ titulo: 'v2' }), expectedRev: 1 })
    const res = await call(Channels.planningSaveCard, { ...ref, card: card({ titulo: 'velho' }), expectedRev: 1 })
    expect(res).toMatchObject({ ok: false, code: 'rev_conflict', current: { titulo: 'v2', rev: 2 } })
    const del = await call(Channels.planningDeleteCard, { ...ref, id: 'nao-existe', expectedRev: 1 })
    expect(del).toEqual({ ok: false, code: 'rev_conflict', current: null })
  })

  it('rev do roteiro desatualizado vira roteiro_conflict com o roteiro atual; nada é gravado', async () => {
    setup()
    const ref = { projectCwd: cwd, slug: 'p' }
    await call(Channels.planningCreate, { ...ref, titulo: 'P' })
    const agente = { titulo: 'P', etapas: [{ id: 'e1', titulo: 'Do agente', status: 'concluida' }] }
    expect(await call(Channels.planningSaveRoteiro, { ...ref, roteiro: agente, expectedRev: 1 })).toMatchObject({
      ok: true,
      roteiro: { rev: 2 }
    })
    const tela = { titulo: 'P', etapas: [{ id: 'e1', titulo: 'Da tela', status: 'pendente' }] }
    const res = await call(Channels.planningSaveRoteiro, { ...ref, roteiro: tela, expectedRev: 1 })
    expect(res).toEqual({
      ok: false,
      code: 'roteiro_conflict',
      message: 'rev do roteiro desatualizado: esperado 1, atual 2',
      current: { ...agente, rev: 2 }
    })
    expect((await call(Channels.planningOpen, ref)).plan.roteiro).toEqual({ ...agente, rev: 2 })
  })

  it('payload fora do formato vira invalid, sem tocar o disco', async () => {
    setup()
    const ref = { projectCwd: cwd, slug: 'p' }
    await call(Channels.planningCreate, { ...ref, titulo: 'P' })
    const bad: [string, unknown][] = [
      [Channels.planningList, undefined],
      [Channels.planningList, { projectCwd: 'relativo/x' }],
      [Channels.planningList, { projectCwd: 42 }],
      [Channels.planningOpen, { projectCwd: cwd, slug: '../fora' }],
      [Channels.planningOpen, { projectCwd: cwd, slug: 'p', extra: true }],
      [Channels.planningCreate, { projectCwd: cwd, slug: 'Maiuscula', titulo: 'x' }],
      [Channels.planningSaveCard, { ...ref, card: card({ tipo: 'outro' as never }), expectedRev: 0 }],
      [Channels.planningSaveCard, { ...ref, card: { ...card(), lixo: 1 }, expectedRev: 0 }],
      [Channels.planningSaveCard, { ...ref, card: card({ id: '../../x' }), expectedRev: 0 }],
      [Channels.planningSaveCard, { ...ref, card: card(), expectedRev: -1 }],
      [Channels.planningSaveCard, { ...ref, card: card(), expectedRev: 1.5 }],
      [Channels.planningDeleteCard, { ...ref, id: 'a/b', expectedRev: 0 }],
      [Channels.planningSaveRoteiro, { ...ref, roteiro: { titulo: 'x', etapas: [{ id: 'e', titulo: 'e', status: 'feita' }] }, expectedRev: 1 }],
      [Channels.planningSaveRoteiro, { ...ref, roteiro: { titulo: 'x', etapas: [] } }],
      [Channels.planningSaveRoteiro, { ...ref, roteiro: { titulo: 'x', etapas: [] }, expectedRev: -1 }],
      [Channels.planningSaveRoteiro, { ...ref, roteiro: { titulo: 'x', etapas: [] }, expectedRev: '1' }],
      [Channels.planningSaveRoteiro, { ...ref, roteiro: { titulo: 'x', rev: 1, etapas: [] }, expectedRev: 1 }],
      [Channels.planningSaveLayout, { ...ref, layout: { positions: { a: { x: 'um', y: 0 } } } }],
      [Channels.planningSaveLayout, { ...ref, layout: { positions: { a: { x: Number.NaN, y: 0 } } } }]
    ]
    for (const [channel, payload] of bad) {
      const res = await call(channel, payload)
      expect(res, `${channel} ${JSON.stringify(payload)}`).toMatchObject({ ok: false, code: 'invalid' })
      expect(typeof res.message).toBe('string')
    }
    // Validação do domínio (depois da fronteira) também vira invalid.
    const semFonte = await call(Channels.planningSaveCard, { ...ref, card: card({ id: 's', tipo: 'sugestao' }), expectedRev: 0 })
    expect(semFonte).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/fonte/) })
    const idRuim = await call(Channels.planningSaveLayout, { ...ref, layout: { positions: { 'A B': { x: 0, y: 0 } } } })
    expect(idRuim).toMatchObject({ ok: false, code: 'invalid' })
    const dup = await call(Channels.planningCreate, { ...ref, titulo: 'P' })
    expect(dup).toMatchObject({ ok: false, code: 'invalid', message: expect.stringMatching(/já existe/) })
    expect(await fs.readdir(path.join(cwd, 'docs', 'spec', 'p', 'cards'))).toEqual([])
  })

  it('projeto ou planejamento inexistente vira not_found', async () => {
    setup()
    const missing = path.join(cwd, 'nao-existe')
    expect(await call(Channels.planningList, { projectCwd: missing })).toMatchObject({ ok: false, code: 'not_found' })
    expect(await call(Channels.planningOpen, { projectCwd: cwd, slug: 'nada' })).toMatchObject({
      ok: false,
      code: 'not_found'
    })
    expect(w.calls).toEqual([])
  })

  it('erro de disco vira io; nenhuma exceção atravessa o IPC', async () => {
    const boom = (): never => {
      throw Object.assign(new Error('EACCES: acesso negado'), { code: 'EACCES' })
    }
    const store = { ...realStore, listPlans: vi.fn(async () => boom()), saveRoteiro: vi.fn(async () => { throw 'texto' }) }
    setup(store)
    expect(await call(Channels.planningList, { projectCwd: cwd })).toEqual({
      ok: false,
      code: 'io',
      message: 'EACCES: acesso negado'
    })
    const res = await call(Channels.planningSaveRoteiro, {
      projectCwd: cwd,
      slug: 'p',
      roteiro: { titulo: 't', etapas: [] },
      expectedRev: 0
    })
    expect(res).toEqual({ ok: false, code: 'io', message: 'texto' })
    expect(toPlanningFailure(new SyntaxError('JSON ruim'))).toMatchObject({ code: 'invalid' })
    expect(toPlanningFailure(Object.assign(new Error('x'), { code: 'ENOENT' }))).toMatchObject({ code: 'not_found' })
  })

  it('open vigia uma vez por janela; close solta; reabrir só revive', async () => {
    setup()
    const ref = { projectCwd: cwd, slug: 'p' }
    await call(Channels.planningCreate, { ...ref, titulo: 'P' })
    await call(Channels.planningOpen, ref, 1)
    await call(Channels.planningOpen, ref, 1) // recarregar após planning:changed
    await call(Channels.planningOpen, ref, 2) // outra janela
    expect(w.calls).toEqual(['watch:p', 'revive:p', 'watch:p'])
    expect(await call(Channels.planningClose, ref, 1)).toEqual({ ok: true })
    expect(await call(Channels.planningClose, ref, 1)).toEqual({ ok: true }) // repetido: nada a soltar
    expect(await call(Channels.planningClose, { projectCwd: cwd, slug: 'outro' }, 1)).toEqual({ ok: true })
    expect(w.calls).toEqual(['watch:p', 'revive:p', 'watch:p', 'unwatch:p'])
  })

  it('close funciona mesmo se a pasta do projeto sumiu', async () => {
    const projeto = path.join(cwd, 'proj')
    await fs.mkdir(projeto)
    setup()
    await call(Channels.planningCreate, { projectCwd: projeto, slug: 'p', titulo: 'P' })
    await call(Channels.planningOpen, { projectCwd: projeto, slug: 'p' })
    await fs.rm(projeto, { recursive: true, force: true })
    expect(await call(Channels.planningClose, { projectCwd: projeto, slug: 'p' })).toEqual({ ok: true })
    expect(w.calls).toEqual(['watch:p', 'unwatch:p'])
  })

  it('mudança vista pelo vigia vira planning:changed para o renderer', () => {
    setup()
    w.emit({ projectCwd: cwd, slug: 'p' })
    expect(sent).toEqual([{ channel: 'planning:changed', payload: { projectCwd: cwd, slug: 'p' } }])
  })

  it('saveRoteiro gravado avisa planning:changed do plano (o vigia ignora a gravação própria); conflito e inválido não', async () => {
    setup()
    const ref = { projectCwd: cwd, slug: 'p' }
    await call(Channels.planningCreate, { ...ref, titulo: 'Sem nome' })
    await call(Channels.planningOpen, ref) // a tela aberta
    expect(sent).toEqual([])

    // O título que a conversa sincroniza (conversationTitle.ts) chega por aqui.
    const renamed = { titulo: 'Checkout com Pix', etapas: [] }
    expect(await call(Channels.planningSaveRoteiro, { ...ref, roteiro: renamed, expectedRev: 1 })).toEqual({
      ok: true,
      roteiro: { ...renamed, rev: 2 }
    })
    expect(sent).toEqual([{ channel: 'planning:changed', payload: ref }])
    // Quem recarrega por esse aviso já vê o nome novo.
    expect((await call(Channels.planningOpen, ref)).plan.roteiro.titulo).toBe('Checkout com Pix')

    sent.length = 0
    const stale = await call(Channels.planningSaveRoteiro, { ...ref, roteiro: { titulo: 'Velho', etapas: [] }, expectedRev: 1 })
    expect(stale).toMatchObject({ ok: false, code: 'roteiro_conflict' })
    const bad = await call(Channels.planningSaveRoteiro, { ...ref, roteiro: { titulo: 'x', etapas: [] } })
    expect(bad).toMatchObject({ ok: false, code: 'invalid' })
    const missing = await call(Channels.planningSaveRoteiro, { projectCwd: cwd, slug: 'nada', roteiro: renamed, expectedRev: 0 })
    expect(missing).toMatchObject({ ok: false })
    expect(sent).toEqual([])
  })

  it('handoffs: writeHandoff grava em _handoff/ e listHandoffs devolve na ordem, sem planning:changed', async () => {
    setup()
    const ref = { projectCwd: cwd, slug: 'p' }
    await call(Channels.planningCreate, { ...ref, titulo: 'P' })
    expect(await call(Channels.planningListHandoffs, ref)).toEqual({ ok: true, handoffs: [] })

    const first = await call(Channels.planningWriteHandoff, { ...ref, conteudo: '# Prompt 1\n' })
    const second = await call(Channels.planningWriteHandoff, { ...ref, conteudo: '# Prompt 2\n' })
    expect(first).toEqual({ ok: true, name: expect.stringMatching(/^\d{4}-\d{2}-\d{2}-01\.md$/) })
    expect(second).toEqual({ ok: true, name: expect.stringMatching(/-02\.md$/) })
    expect(await fs.readFile(path.join(cwd, 'docs', 'spec', 'p', '_handoff', first.name), 'utf8')).toBe('# Prompt 1\n')

    const listed = await call(Channels.planningListHandoffs, ref)
    expect(listed.ok).toBe(true)
    expect(listed.handoffs.map((h: { name: string; content: string }) => [h.name, h.content])).toEqual([
      [first.name, '# Prompt 1\n'],
      [second.name, '# Prompt 2\n']
    ])
    expect(typeof listed.handoffs[0].createdAt).toBe('number')
    // _handoff/ é gravado pela própria tela: nada de planning:changed.
    expect(sent).toEqual([])
  })

  it('handoffs: payload inválido, prompt vazio e planejamento inexistente não gravam nada', async () => {
    setup()
    const ref = { projectCwd: cwd, slug: 'p' }
    await call(Channels.planningCreate, { ...ref, titulo: 'P' })
    const bad: unknown[] = [
      { ...ref },
      { ...ref, conteudo: '' },
      { ...ref, conteudo: '   \n' },
      { ...ref, conteudo: 42 },
      { ...ref, conteudo: 'x', extra: 1 },
      { projectCwd: cwd, slug: '../fora', conteudo: 'x' },
      { projectCwd: 'relativo', slug: 'p', conteudo: 'x' },
      { ...ref, conteudo: 'x'.repeat(1_000_001) }
    ]
    for (const payload of bad) {
      expect(await call(Channels.planningWriteHandoff, payload)).toMatchObject({ ok: false, code: 'invalid' })
    }
    expect(await call(Channels.planningListHandoffs, { ...ref, extra: 1 })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await call(Channels.planningWriteHandoff, { projectCwd: cwd, slug: 'nada', conteudo: 'x' })).toMatchObject({
      ok: false,
      code: 'not_found'
    })
    await expect(fs.stat(path.join(cwd, 'docs', 'spec', 'p', '_handoff'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(cwd, 'docs', 'spec', 'nada'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('close que chega enquanto o open lê o plano: o open não registra vigia (nada vaza)', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const store: PlanningStoreApi = {
      ...realStore,
      openPlan: async (projectCwd, slug) => {
        await gate
        return realStore.openPlan(projectCwd, slug)
      }
    }
    setup(store)
    const ref = { projectCwd: cwd, slug: 'p' }
    await call(Channels.planningCreate, { ...ref, titulo: 'P' })
    const opening = call(Channels.planningOpen, ref, 1)
    expect(await call(Channels.planningClose, ref, 1)).toEqual({ ok: true })
    release()
    expect(await opening).toMatchObject({ ok: true, plan: { slug: 'p' } })
    expect(w.calls).toEqual([])
    // Reabrir depois funciona normalmente, e o close solta.
    await call(Channels.planningOpen, ref, 1)
    await call(Channels.planningClose, ref, 1)
    expect(w.calls).toEqual(['watch:p', 'unwatch:p'])
  })

  it('close que chega enquanto o open confere a pasta do projeto também não vaza', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    let calls = 0
    registerPlanningIpc({
      handle: (channel, listener) => void handlers.set(channel, listener),
      send: (channel, payload) => void sent.push({ channel, payload }),
      createWatcher: w.create,
      // A 1ª conferência (a do open) fica presa até o close chegar.
      isDirectory: async () => {
        if (calls++ === 1) await gate
        return true
      }
    })
    const ref = { projectCwd: cwd, slug: 'p' }
    await call(Channels.planningCreate, { ...ref, titulo: 'P' })
    const opening = call(Channels.planningOpen, ref, 7)
    await call(Channels.planningClose, ref, 7)
    release()
    expect((await opening).ok).toBe(true)
    expect(w.calls).toEqual([])
  })

  it('close de OUTRA janela ou de outro plano não cancela o open em andamento', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const store: PlanningStoreApi = {
      ...realStore,
      openPlan: async (projectCwd, slug) => {
        await gate
        return realStore.openPlan(projectCwd, slug)
      }
    }
    setup(store)
    const ref = { projectCwd: cwd, slug: 'p' }
    await call(Channels.planningCreate, { ...ref, titulo: 'P' })
    const opening = call(Channels.planningOpen, ref, 1)
    await call(Channels.planningClose, ref, 2)
    await call(Channels.planningClose, { projectCwd: cwd, slug: 'outro' }, 1)
    release()
    await opening
    expect(w.calls).toEqual(['watch:p'])
  })

  it('close() fecha as vigias e esquece as aberturas', async () => {
    const handle = setup()
    const ref = { projectCwd: cwd, slug: 'p' }
    await call(Channels.planningCreate, { ...ref, titulo: 'P' })
    await call(Channels.planningOpen, ref)
    handle.close()
    await call(Channels.planningOpen, ref)
    expect(w.calls).toEqual(['watch:p', 'closeAll', 'watch:p'])
  })
})
