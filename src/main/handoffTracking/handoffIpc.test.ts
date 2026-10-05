// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { AgentCodeApi, HandoffRegisterRequest } from '../../shared/api'
import type { HandoffEnvio } from '../../shared/handoffTracking'
import { Channels } from '../../shared/ipc'
import type { HandoffRepository } from '../persistence/types'
import type { HandoffCorrection, HandoffTracker } from './handoffTracker'
import { registerHandoffIpc, type HandoffIpcListener } from './handoffIpc'

// O preload de verdade com o electron de mentira: window.api.handoffRegister
// chega ao canal que registerHandoffIpc atende (src/preload/index.test.ts está
// fora do escopo desta etapa).
const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
  webUtils: { getPathForFile: vi.fn(() => '') }
}))

const CWD = process.platform === 'win32' ? 'C:\\proj\\app' : '/proj/app'

function valid(over: Partial<HandoffRegisterRequest> = {}): HandoffRegisterRequest {
  return {
    projectCwd: CWD,
    slug: 'checkout',
    conversationId: 'conv-1',
    conversationTitle: 'Implementação: Checkout',
    prompts: [
      { arquivo: '2026-10-05-01.md', conteudo: '# Prompt 1' },
      { arquivo: '2026-10-05-02.md', conteudo: '# Prompt 2' }
    ],
    ...over
  }
}

function setup(register = vi.fn(async () => [] as HandoffEnvio[]), repository: () => null = () => null) {
  const handlers = new Map<string, HandoffIpcListener>()
  registerHandoffIpc({ handle: (channel, listener) => handlers.set(channel, listener), repository, register })
  const call = (payload: unknown) => handlers.get(Channels.handoffRegister)!({}, payload) as Promise<unknown>
  return { handlers, register, call }
}

describe('handoff:register', () => {
  it('pedido válido chega ao registro e a resposta traz os envios', async () => {
    const envio = { id: 'he-1' } as HandoffEnvio
    const { call, register } = setup(vi.fn(async () => [envio]))
    await expect(call(valid())).resolves.toEqual({ ok: true, envios: [envio] })
    expect(register).toHaveBeenCalledTimes(1)
    expect((register.mock.calls[0] as unknown[])[0]).toEqual(valid())
  })

  it.each([
    ['projectCwd relativo', valid({ projectCwd: 'proj/app' }), /projectCwd/],
    ['slug fora de [a-z0-9-]', valid({ slug: 'Checkout!' }), /slug/],
    ['conversationId vazio', valid({ conversationId: '' }), /conversationId/],
    ['conversationId longo demais', valid({ conversationId: 'x'.repeat(201) }), /conversationId/],
    ['título vazio', valid({ conversationTitle: '' }), /conversationTitle/],
    ['título com mais de 500', valid({ conversationTitle: 't'.repeat(501) }), /conversationTitle/],
    ['nenhum prompt', valid({ prompts: [] }), /prompts/],
    [
      'mais de 50 prompts',
      valid({ prompts: Array.from({ length: 51 }, (_, i) => ({ arquivo: `p-${i}.md`, conteudo: 'x' })) }),
      /prompts/
    ],
    ['arquivo com caminho', valid({ prompts: [{ arquivo: '..\\fora.md', conteudo: 'x' }] }), /arquivo/],
    ['arquivo que não é .md', valid({ prompts: [{ arquivo: 'enviados.json', conteudo: 'x' }] }), /arquivo/],
    ['conteúdo em branco', valid({ prompts: [{ arquivo: 'a.md', conteudo: '  \n ' }] }), /conteudo/],
    ['conteúdo acima do teto', valid({ prompts: [{ arquivo: 'a.md', conteudo: 'x'.repeat(1_000_001) }] }), /conteudo/],
    ['campo a mais', { ...valid(), extra: 1 }, /extra|Unrecognized/i]
  ])('recusa %s sem chamar o registro', async (_caso, payload, message) => {
    const { call, register } = setup()
    const res = (await call(payload)) as { ok: boolean; message: string }
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(message)
    expect(register).not.toHaveBeenCalled()
  })

  it('payload que nem é objeto vira { ok: false }', async () => {
    const { call } = setup()
    await expect(call(null)).resolves.toMatchObject({ ok: false })
    await expect(call('texto')).resolves.toMatchObject({ ok: false })
  })

  it('exceção do registro não atravessa o IPC: vira { ok: false, message }', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { call } = setup(
      vi.fn(async () => {
        throw new Error('planejamento não encontrado: checkout')
      })
    )
    await expect(call(valid())).resolves.toEqual({ ok: false, message: 'planejamento não encontrado: checkout' })
    warn.mockRestore()
  })

  it('com o registro de verdade e sem banco: ok com nenhum envio', async () => {
    const handlers = new Map<string, HandoffIpcListener>()
    registerHandoffIpc({ handle: (channel, listener) => handlers.set(channel, listener), repository: () => null })
    await expect(handlers.get(Channels.handoffRegister)!({}, valid())).resolves.toEqual({ ok: true, envios: [] })
  })
})

describe('handoff:register — aviso ao acompanhamento', () => {
  it('envios registrados vão para o tracker (o texto já enviado casa agora); nenhum, nada', async () => {
    const envio = { id: 'he-1', conversationId: 'conv-1' } as HandoffEnvio
    const tracker = { onRegistered: vi.fn(), correctEntrega: vi.fn(async (_req: HandoffCorrection) => envio) }
    const handlers = new Map<string, HandoffIpcListener>()
    const register = vi.fn().mockResolvedValueOnce([envio]).mockResolvedValueOnce([])
    registerHandoffIpc({ handle: (c, l) => handlers.set(c, l), repository: () => null, register, tracker })
    await handlers.get(Channels.handoffRegister)!({}, valid())
    expect(tracker.onRegistered).toHaveBeenCalledWith([envio])
    await handlers.get(Channels.handoffRegister)!({}, valid())
    expect(tracker.onRegistered).toHaveBeenCalledTimes(1)
  })
})

describe('handoff:list', () => {
  function listSetup(repository: Partial<HandoffRepository> | null = { listHandoffEnvios: vi.fn(async () => []) }) {
    const handlers = new Map<string, HandoffIpcListener>()
    const projectId = vi.fn(async (cwd: string) => (cwd === CWD ? 'proj-1' : ''))
    registerHandoffIpc({
      handle: (c, l) => handlers.set(c, l),
      repository: () => repository as HandoffRepository | null,
      projectId
    })
    const call = (payload: unknown) => handlers.get(Channels.handoffList)!({}, payload) as Promise<unknown>
    return { call, list: repository?.listHandoffEnvios as ReturnType<typeof vi.fn>, projectId }
  }

  it('sem filtro = todos os projetos; conversa; projeto pela identidade estável; limite', async () => {
    const envio = { id: 'he-1' } as HandoffEnvio
    const { call, list } = listSetup({ listHandoffEnvios: vi.fn(async () => [envio]) })
    await expect(call({})).resolves.toEqual({ ok: true, envios: [envio] })
    await call({ conversationId: 'conv-1' })
    await call({ projectCwd: CWD, limit: 50 })
    await call({ projectCwd: CWD, conversationId: 'conv-1' })
    expect(list.mock.calls.map((c) => c[0])).toEqual([
      {},
      { conversationId: 'conv-1' },
      { projectIds: ['proj-1'], limit: 50 },
      { conversationId: 'conv-1', projectIds: ['proj-1'] }
    ])
  })

  it.each([
    ['projectCwd relativo', { projectCwd: 'proj' }, /projectCwd/],
    ['limit zero', { limit: 0 }, /limit/],
    ['limit acima do teto', { limit: 1001 }, /limit/],
    ['limit fracionário', { limit: 1.5 }, /limit/],
    ['conversationId vazio', { conversationId: '' }, /conversationId/],
    ['campo a mais', { status: 'na_fila' }, /status|Unrecognized/i],
    ['payload que não é objeto', 'tudo', /.+/]
  ])('recusa %s sem tocar o banco', async (_caso, payload, message) => {
    const { call, list } = listSetup()
    const res = (await call(payload)) as { ok: boolean; message: string }
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(message)
    expect(list).not.toHaveBeenCalled()
  })

  it('sem banco ou projeto sem identidade: { ok: false } — lista vazia mentiria', async () => {
    await expect(listSetup(null).call({})).resolves.toEqual({ ok: false, message: 'O banco está indisponível agora.' })
    const other = process.platform === 'win32' ? 'C:\\sumiu' : '/sumiu'
    await expect(listSetup().call({ projectCwd: other })).resolves.toMatchObject({ ok: false, message: /identificar o projeto/ })
  })
})

describe('handoff:correctEntrega', () => {
  type CorrectTracker = Pick<HandoffTracker, 'onRegistered' | 'correctEntrega'>
  function correctSetup(tracker?: CorrectTracker) {
    const handlers = new Map<string, HandoffIpcListener>()
    registerHandoffIpc({ handle: (c, l) => handlers.set(c, l), repository: () => null, tracker })
    return (payload: unknown) => handlers.get(Channels.handoffCorrectEntrega)!({}, payload) as Promise<unknown>
  }

  it('pedido válido vai ao tracker (motivo em branco é omitido) e volta o envio reavaliado', async () => {
    const envio = { id: 'he-1' } as HandoffEnvio
    const tracker = { onRegistered: vi.fn(), correctEntrega: vi.fn(async (_req: HandoffCorrection) => envio) }
    const call = correctSetup(tracker)
    await expect(call({ entregaId: 'hn-1', acao: 'concluir', motivo: 'conferi' })).resolves.toEqual({ ok: true, envio })
    await call({ entregaId: 'hn-1', acao: 'reabrir', motivo: '   ' })
    expect(tracker.correctEntrega.mock.calls.map((c) => c[0])).toEqual([
      { entregaId: 'hn-1', acao: 'concluir', motivo: 'conferi' },
      { entregaId: 'hn-1', acao: 'reabrir' }
    ])
  })

  it.each([
    ['ação desconhecida', { entregaId: 'hn-1', acao: 'apagar' }, /acao/],
    ['sem entregaId', { acao: 'concluir' }, /entregaId/],
    ['motivo acima de 500', { entregaId: 'hn-1', acao: 'concluir', motivo: 'm'.repeat(501) }, /motivo/],
    ['campo a mais', { entregaId: 'hn-1', acao: 'concluir', status: 'concluida' }, /status|Unrecognized/i]
  ])('recusa %s sem chamar o tracker', async (_caso, payload, message) => {
    const tracker = { onRegistered: vi.fn(), correctEntrega: vi.fn(async (_req: HandoffCorrection) => ({}) as HandoffEnvio) }
    const res = (await correctSetup(tracker)(payload)) as { ok: boolean; message: string }
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(message)
    expect(tracker.correctEntrega).not.toHaveBeenCalled()
  })

  it('falha do tracker (entrega que não existe, sem banco) e tracker ausente viram { ok: false }', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tracker = {
      onRegistered: vi.fn(),
      correctEntrega: vi.fn(async () => {
        throw new Error('Entrega de handoff não encontrada: hn-x')
      })
    }
    await expect(correctSetup(tracker)({ entregaId: 'hn-x', acao: 'concluir' })).resolves.toEqual({
      ok: false,
      message: 'Entrega de handoff não encontrada: hn-x'
    })
    await expect(correctSetup()({ entregaId: 'hn-x', acao: 'concluir' })).resolves.toMatchObject({ ok: false })
    warn.mockRestore()
  })
})

describe('preload — handoff', () => {
  it('handoffRegister invoca handoff:register; planningWriteHandoff repassa as etapas', async () => {
    await import('../../preload/index')
    const api = electron.exposeInMainWorld.mock.calls[0][1] as AgentCodeApi
    const answer = { ok: true, envios: [] }
    electron.invoke.mockResolvedValueOnce(answer).mockResolvedValueOnce({ ok: true, name: '2026-10-05-03.md' })
    await expect(api.handoffRegister(valid())).resolves.toBe(answer)
    const write = { projectCwd: CWD, slug: 'checkout', conteudo: 'editado', etapas: ['pagamento'] }
    await api.planningWriteHandoff(write)
    expect(electron.invoke).toHaveBeenNthCalledWith(1, Channels.handoffRegister, valid())
    expect(electron.invoke).toHaveBeenNthCalledWith(2, Channels.planningWriteHandoff, write)
  })

  it('handoffList (sem filtro = {}), handoffCorrectEntrega e onHandoffChanged nos canais certos', async () => {
    await import('../../preload/index')
    const api = electron.exposeInMainWorld.mock.calls[0][1] as AgentCodeApi
    electron.invoke.mockClear()
    electron.invoke.mockResolvedValue({ ok: true, envios: [] })
    await api.handoffList()
    await api.handoffList({ conversationId: 'conv-1' })
    await api.handoffCorrectEntrega({ entregaId: 'hn-1', acao: 'reabrir' })
    expect(electron.invoke.mock.calls).toEqual([
      [Channels.handoffList, {}],
      [Channels.handoffList, { conversationId: 'conv-1' }],
      [Channels.handoffCorrectEntrega, { entregaId: 'hn-1', acao: 'reabrir' }]
    ])

    const seen: unknown[] = []
    const off = api.onHandoffChanged((msg) => seen.push(msg))
    const [channel, listener] = electron.on.mock.calls.find((c) => c[0] === Channels.handoffChanged)!
    expect(channel).toBe('handoff:changed')
    listener({}, { conversationId: 'conv-1' })
    expect(seen).toEqual([{ conversationId: 'conv-1' }])
    off()
    expect(electron.removeListener).toHaveBeenCalledWith(Channels.handoffChanged, listener)
  })
})
