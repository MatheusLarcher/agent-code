// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandoffQueueListResult } from '../../shared/api'
import { isRoutineEnvio } from '../../shared/handoffTracking'
import { Channels, type BoardItem, type ChatEvent } from '../../shared/ipc'
import { decideQueue } from '../handoffTracking/handoffQueue'
import { registerHandoffQueueIpc, type HandoffQueueIpcListener } from '../handoffTracking/handoffQueueIpc'
import { CONV, closeHarnesses, harness, type Harness } from '../handoffTracking/handoffTrackerHarness'
import { applyPoVerdict, type PoApplyDeps } from './poApply'
import { parsePoAuthorization, PO_ROUTINE_REASON, PoAuthorizationStore, routineFor, routineText } from './poAuthorization'
import { createPoAuthorizations } from './poAuthorizationBoot'
import { PO_AWAITING_AUTHORIZATION_REASON } from './poPromptText'

/**
 * A autorização do PO para commit e push: a frase vira AUTORIZAR na abertura
 * (alcance "fila" só com fila; "commita isso" não autoriza), REVOGAR e o chip
 * tiram, a "desta fila" acaba quando a fila esvazia, a pendência de commit vira
 * ROTINA na frente dos prompts com o texto fixo — só o título do cartão de
 * origem entra, nada do modelo — e push só com autorização de push.
 */

afterEach(closeHarnesses)

describe('a frase e o texto fixo', () => {
  it('AUTORIZAR | commit|commit+push | fila|sempre e REVOGAR; o resto não autoriza', () => {
    expect(parsePoAuthorization('ANDAMENTO c1 | começou\nAUTORIZAR | commit+push | fila')).toEqual({ kind: 'autorizar', push: true, scope: 'fila' })
    expect(parsePoAuthorization('AUTORIZAR | commit | sempre')).toEqual({ kind: 'autorizar', push: false, scope: 'sempre' })
    expect(parsePoAuthorization('REVOGAR')).toEqual({ kind: 'revogar' })
    expect(parsePoAuthorization('AUTORIZAR | push | sempre')).toBeNull()
    expect(parsePoAuthorization('AUTORIZAR | commit')).toBeNull()
    expect(parsePoAuthorization('NOVA | Commitar isso | o usuário pediu')).toBeNull()
  })

  it('o texto da rotina é fixo: só o título entra (sem crase nem quebra); push só quando autorizado', () => {
    expect(routineText('Implementar a fase 1', false)).toBe('Faça o commit das mudanças de: Implementar a fase 1.')
    expect(routineText('Implementar a fase 1', true)).toBe('Faça o commit das mudanças de: Implementar a fase 1 e dê push na branch atual, sem --force.')
    expect(routineText('Fase `1`\n e rm -rf /', false)).toBe('Faça o commit das mudanças de: Fase 1 e rm -rf /.')
    const commitOnly = { push: false, scope: 'sempre' as const, at: 'x' }
    expect(routineFor('Commitar a fase 1', commitOnly)).toBe(true)
    expect(routineFor('Dar push da fase 1', commitOnly)).toBe(false)
    expect(routineFor('Dar push da fase 1', { ...commitOnly, push: true })).toBe(true)
    expect(routineFor('Verificar no app rodando', { ...commitOnly, push: true })).toBe(false)
  })

  it('o armazenamento: grava, revoga e ignora lixo', async () => {
    let value: string | null = 'lixo{'
    const changed = vi.fn()
    const store = new PoAuthorizationStore({ read: async () => value, write: async (v) => void (value = v), changed })
    expect(await store.all()).toEqual({})
    await store.set('c1', { push: true, scope: 'sempre', at: 'x' })
    expect(await store.get('c1')).toEqual({ push: true, scope: 'sempre', at: 'x' })
    await store.set('c1', null)
    expect(await store.get('c1')).toBeNull()
    expect(changed).toHaveBeenCalledTimes(2)
  })
})

describe('poApply — a pendência de commit vira rotina; a frase vira autorização', () => {
  const parent = { id: 'c1', sourceTitle: 'Implementar a fase 1', poTitle: 'Título que o PO escreveu', sourceStatus: 'completed' } as unknown as BoardItem
  function deps() {
    const createPoItem = vi.fn(async (input: { reason: string }) => ({ id: 'novo', ...input }))
    return {
      createPoItem,
      queueRoutine: vi.fn(async () => undefined),
      authorize: vi.fn(async () => undefined),
      deps: {
        board: { list: vi.fn(async () => [parent]), applyPo: vi.fn(), createPoItem },
        queueRoutine: undefined as unknown,
        authorize: undefined as unknown
      }
    }
  }
  const target = { convId: CONV, cwd: 'C:/p', projectId: 'p', startedAt: 0, returned: [] as BoardItem[] }
  const verdict = `CONCLUIR c1 | entregue\nNOVA c1 | Commitar a fase 1 | ${PO_AWAITING_AUTHORIZATION_REASON}`

  it('com autorização: a pendência não espera você e a rotina leva o título do cartão de ORIGEM', async () => {
    const d = deps()
    const all = { ...d.deps, queueRoutine: d.queueRoutine } as unknown as PoApplyDeps
    await applyPoVerdict(all, { ...target, phase: 'close', authorization: { push: true, scope: 'fila', at: 'x' } }, verdict, [parent], { applied: 0, touched: [] })
    expect(d.createPoItem).toHaveBeenCalledWith(expect.objectContaining({ title: 'Commitar a fase 1', reason: PO_ROUTINE_REASON, parentId: 'c1' }))
    expect(d.queueRoutine).toHaveBeenCalledWith(CONV, { title: 'Implementar a fase 1', push: true, cwd: 'C:/p', projectId: 'p' })
  })

  it('sem autorização (ou só commit para uma pendência de push): tudo como antes, "aguardando você"', async () => {
    const d = deps()
    const all = { ...d.deps, queueRoutine: d.queueRoutine } as unknown as PoApplyDeps
    await applyPoVerdict(all, { ...target, phase: 'close', authorization: null }, verdict, [parent], { applied: 0, touched: [] })
    expect(d.createPoItem).toHaveBeenCalledWith(expect.objectContaining({ reason: PO_AWAITING_AUTHORIZATION_REASON }))
    const push = `NOVA c1 | Dar push da fase 1 | ${PO_AWAITING_AUTHORIZATION_REASON}`
    await applyPoVerdict(all, { ...target, phase: 'close', authorization: { push: false, scope: 'sempre', at: 'x' } }, push, [parent], { applied: 0, touched: [] })
    expect(d.queueRoutine).not.toHaveBeenCalled()
  })

  it('a abertura lê AUTORIZAR/REVOGAR; o fechamento não', async () => {
    const d = deps()
    const all = { ...d.deps, authorize: d.authorize } as unknown as PoApplyDeps
    await applyPoVerdict(all, { ...target, phase: 'open' }, 'AUTORIZAR | commit+push | sempre', [], { applied: 0, touched: [] })
    expect(d.authorize).toHaveBeenCalledWith(CONV, { kind: 'autorizar', push: true, scope: 'sempre' })
    await applyPoVerdict(all, { ...target, phase: 'close' }, 'REVOGAR', [], { applied: 0, touched: [] })
    await applyPoVerdict(all, { ...target, phase: 'open' }, 'OK', [], { applied: 0, touched: [] })
    expect(d.authorize).toHaveBeenCalledTimes(1)
  })
})

const turnStart: ChatEvent = { kind: 'turn-start', turnIds: ['u1'] }
const ok: ChatEvent = { kind: 'result', id: 'r1', isError: false, text: 'Pronto.', durationMs: 1 }

async function setup(h: Harness) {
  let value: string | null = null
  const changed = vi.fn()
  const auth = createPoAuthorizations({
    repository: () => h.repo,
    read: async () => value,
    write: async (_key, v) => void (value = v),
    publish: vi.fn(),
    changed
  })
  return { auth, changed }
}

async function turn(h: Harness, prompt: string, tasks: Array<[string, 'in_progress' | 'completed']>, envioId?: string) {
  if (envioId) await h.tracker.dispatched(CONV, envioId)
  h.tracker.noteUserSend(CONV, prompt)
  h.advance(1_000)
  h.emit(turnStart)
  h.tasks(tasks)
  h.advance(1_000)
  h.emit(ok)
  await h.settle()
}

describe('o alcance da autorização e a rotina na fila (SQLite de verdade)', () => {
  it('"fila" só com fila; acaba sozinha quando a fila esvazia', async () => {
    const h = await harness()
    const { auth } = await setup(h)
    // Sem fila: "quando terminar, commit e push" é pedido normal.
    await auth.authorize(CONV, { kind: 'autorizar', push: true, scope: 'fila' })
    expect(await auth.store.get(CONV)).toBeNull()

    const [first, second] = await h.register([{ conteudo: 'Prompt 1', etapas: ['a'] }, { conteudo: 'Prompt 2', etapas: ['b'] }])
    await auth.authorize(CONV, { kind: 'autorizar', push: true, scope: 'fila' })
    expect(await auth.store.get(CONV)).toMatchObject({ push: true, scope: 'fila', loteId: first.loteId })

    await turn(h, 'Prompt 1', [['[a] Etapa a', 'completed']], first.id)
    await auth.expire(CONV)
    expect(await auth.store.get(CONV)).not.toBeNull()
    await turn(h, 'Prompt 2', [['[a] Etapa a', 'completed'], ['[b] Etapa b', 'completed']], second.id)
    await auth.expire(CONV)
    expect(await auth.store.get(CONV)).toBeNull()
  })

  it('"sempre" fica até revogar (pelo chat ou pelo chip)', async () => {
    const h = await harness()
    const { auth } = await setup(h)
    await auth.authorize(CONV, { kind: 'autorizar', push: false, scope: 'sempre' })
    await auth.expire(CONV)
    expect(await auth.store.get(CONV)).toMatchObject({ scope: 'sempre', push: false })
    await auth.authorize(CONV, { kind: 'revogar' })
    expect(await auth.store.get(CONV)).toBeNull()

    await auth.authorize(CONV, { kind: 'autorizar', push: true, scope: 'sempre' })
    const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
    auth.registerIpc((channel, listener) => handlers.set(channel, listener))
    expect(await handlers.get(Channels.poAuthorizationRevoke)!(null, { conversationId: CONV })).toEqual({ ok: true })
    expect(await handlers.get(Channels.poAuthorizationList)!(null)).toEqual({ ok: true, authorizations: {} })
  })

  it('a rotina sai na frente do próximo prompt, segura o seguinte enquanto roda e mostra "commit + push autorizado"', async () => {
    const h = await harness()
    const { auth, changed } = await setup(h)
    const [first, second] = await h.register([{ conteudo: 'Prompt 1', etapas: ['a'] }, { conteudo: 'Prompt 2', etapas: ['b'] }])
    await turn(h, 'Prompt 1', [['[a] Etapa a', 'completed']], first.id)
    await auth.queueRoutine(CONV, { title: 'Etapa a', push: true, cwd: h.cwd, projectId: h.projectId })
    await auth.queueRoutine(CONV, { title: 'De novo', push: true, cwd: h.cwd, projectId: h.projectId })
    expect(changed).toHaveBeenCalledTimes(1)

    const envios = await h.repo.listHandoffEnvios({ conversationId: CONV })
    const routine = envios.find(isRoutineEnvio)!
    expect(routine.conteudo).toBe('Faça o commit das mudanças de: Etapa a e dê push na branch atual, sem --force.')
    expect(decideQueue(envios)).toMatchObject({ kind: 'next', envio: { id: routine.id } })

    const handlers = new Map<string, HandoffQueueIpcListener>()
    registerHandoffQueueIpc({ handle: (c, l) => handlers.set(c, l), repository: () => h.repo, tracker: h.tracker })
    const list = (await handlers.get(Channels.handoffQueueList)!(null, {})) as HandoffQueueListResult
    expect(list).toMatchObject({ ok: true, items: [{ envioId: routine.id, estado: 'rotina', motivo: 'commit + push autorizado' }, { envioId: second.id, totalPrompts: 2 }] })

    // A rotina saiu e roda: o prompt 2 espera ela acabar.
    await h.tracker.dispatched(CONV, routine.id)
    h.tracker.noteUserSend(CONV, routine.conteudo)
    h.emit(turnStart)
    await h.settle()
    expect(decideQueue(await h.repo.listHandoffEnvios({ conversationId: CONV }))).toMatchObject({
      kind: 'hold',
      motivo: 'o commit autorizado ainda está rodando'
    })
    h.emit(ok)
    await h.settle()
    expect(decideQueue(await h.repo.listHandoffEnvios({ conversationId: CONV }))).toMatchObject({ kind: 'next', envio: { id: second.id } })
  })
})

describe('a frase da pendência que espera o usuário', () => {
  it('o PO e o quadro usam a MESMA frase (o selo "Aguardando você" depende dela)', async () => {
    const { BOARD_PO_AWAITING_REASON } = await import('../../shared/ipc')
    expect(PO_AWAITING_AUTHORIZATION_REASON).toBe(BOARD_PO_AWAITING_REASON)
  })
})
