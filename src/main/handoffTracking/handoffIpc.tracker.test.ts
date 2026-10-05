// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { HandoffCorrectEntregaResult, HandoffListResult } from '../../shared/api'
import { Channels, type ChatEvent } from '../../shared/ipc'
import { registerHandoffIpc, type HandoffIpcListener } from './handoffIpc'
import { CONV, closeHarnesses, harness } from './handoffTrackerHarness'

// A correção manual e a leitura pelo IPC, com o tracker, o SqliteRepository e o
// BoardService de verdade: a correção fica registrada como do usuário e o
// acompanhamento automático passa a respeitá-la.

afterEach(closeHarnesses)

const turnStart: ChatEvent = { kind: 'turn-start', turnIds: ['u1'] }
const result: ChatEvent = { kind: 'result', id: 'r1', isError: false, text: 'Pronto.', durationMs: 1 }

async function setup() {
  const h = await harness()
  const handlers = new Map<string, HandoffIpcListener>()
  registerHandoffIpc({
    handle: (channel, listener) => handlers.set(channel, listener),
    repository: () => h.repo,
    projectId: (cwd) => h.board.projectId(cwd),
    tracker: h.tracker
  })
  const correct = (payload: unknown) =>
    handlers.get(Channels.handoffCorrectEntrega)!({}, payload) as Promise<HandoffCorrectEntregaResult>
  const list = (payload: unknown) => handlers.get(Channels.handoffList)!({}, payload) as Promise<HandoffListResult>
  await h.register([{ conteudo: 'Prompt 1', etapas: ['a', 'b'] }])
  h.tracker.noteUserSend(CONV, 'Prompt 1')
  h.emit(turnStart)
  await h.settle()
  const [envio] = await h.envios()
  return { h, correct, list, a: envio.entregas[0].id, b: envio.entregas[1].id }
}

describe('handoff:correctEntrega com o acompanhamento de verdade', () => {
  it('concluir à mão: registrada como do usuário e o Quadro não a desfaz; com a outra pronta, o envio conclui', async () => {
    const { h, correct, a } = await setup()
    h.tasks([
      ['[a] Fazer A', 'pending'],
      ['[b] Fazer B', 'in_progress']
    ])
    await h.settle()
    const changedBefore = h.changed.length
    const res = await correct({ entregaId: a, acao: 'concluir', motivo: 'conferi no app rodando' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.envio.entregas[0]).toMatchObject({
      status: 'concluida',
      corrigidoPor: 'usuario',
      corrigidoEm: new Date(h.now()).toISOString(),
      motivo: 'corrigido por você: conferi no app rodando',
      auditada: false
    })
    expect(h.changed.length).toBeGreaterThan(changedBefore)

    // O agente ainda diz "a fazer" para [a]: a correção do usuário prevalece.
    h.tasks([
      ['[a] Fazer A', 'pending'],
      ['[b] Fazer B', 'completed']
    ])
    h.emit(result)
    await h.settle()
    const [envio] = await h.envios()
    expect(envio.entregas[0]).toMatchObject({ status: 'concluida', corrigidoPor: 'usuario' })
    expect(envio.status).toBe('concluida')
  })

  it('reabrir num envio concluído: volta a incompleta dizendo o porquê; o Quadro não a reconclui', async () => {
    const { h, correct, a } = await setup()
    h.tasks([
      ['[a] Fazer A', 'completed'],
      ['[b] Fazer B', 'completed']
    ])
    h.emit(result)
    await h.settle()
    expect((await h.envios())[0].status).toBe('concluida')

    const res = await correct({ entregaId: a, acao: 'reabrir', motivo: 'o botão não salva' })
    expect(res).toMatchObject({
      ok: true,
      envio: { status: 'incompleta', concluidoEm: null, motivo: 'faltou 1 de 2 entregas: [a] Etapa a — corrigido por você: o botão não salva' }
    })
    h.tasks([
      ['[a] Fazer A', 'completed'],
      ['[b] Fazer B', 'completed']
    ])
    await h.settle()
    const [envio] = await h.envios()
    expect(envio.entregas[0]).toMatchObject({ status: 'pendente', corrigidoPor: 'usuario', concluidaEm: null })
    expect(envio.status).toBe('incompleta')
  })

  it('entrega que não existe: { ok: false } com a mensagem', async () => {
    const { correct } = await setup()
    const res = await correct({ entregaId: 'hn-nao-existe', acao: 'concluir' })
    expect(res.ok).toBe(false)
  })
})

describe('handoff:list com o banco de verdade', () => {
  it('todos os projetos, um projeto (pela pasta) e uma conversa', async () => {
    const { h, list } = await setup()
    await h.register([{ conteudo: 'Outro', etapas: [] }], 'outra-conversa')
    const all = await list({})
    const byProject = await list({ projectCwd: h.cwd })
    const byConv = await list({ conversationId: CONV })
    expect(all.ok && all.envios.map((e) => e.conversationId).sort()).toEqual([CONV, 'outra-conversa'])
    expect(byProject.ok && byProject.envios).toHaveLength(2)
    expect(byConv.ok && byConv.envios.map((e) => [e.conversationId, e.status, e.entregas.length])).toEqual([[CONV, 'em_execucao', 2]])
  })
})
