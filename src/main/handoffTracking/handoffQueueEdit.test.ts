// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { HandoffQueueEditResult, HandoffQueueListResult } from '../../shared/api'
import { HANDOFF_REMOVED_MOTIVO, type HandoffEnvio } from '../../shared/handoffTracking'
import { Channels, type ChatEvent } from '../../shared/ipc'
import { decideQueue } from './handoffQueue'
import { registerHandoffQueueIpc, type HandoffQueueIpcListener } from './handoffQueueIpc'
import { CONV, closeHarnesses, harness, type Harness } from './handoffTrackerHarness'

/**
 * As ações da faixa "Próximos prompts" (SQLite de verdade): tirar da fila (o
 * envio fica com o motivo e não sai mais), editar o texto (e o hash) e
 * reordenar os prompts de UM plano — nunca um prompt de um plano entre os de
 * outro. E o item da faixa traz etapas, o "de N" e o texto.
 */

afterEach(closeHarnesses)

function ipc(h: Harness) {
  const handlers = new Map<string, HandoffQueueIpcListener>()
  const changed: string[] = []
  registerHandoffQueueIpc({
    handle: (channel, listener) => handlers.set(channel, listener),
    repository: () => h.repo,
    tracker: h.tracker,
    changed: (id) => changed.push(id)
  })
  const call = <T>(channel: string, payload?: unknown): Promise<T> => Promise.resolve(handlers.get(channel)!(null, payload) as T)
  return {
    changed,
    edit: (payload: unknown) => call<HandoffQueueEditResult>(Channels.handoffQueueEdit, payload),
    reorder: (envioIds: string[], conversationId = CONV) => call<HandoffQueueEditResult>(Channels.handoffQueueReorder, { conversationId, envioIds }),
    list: () => call<HandoffQueueListResult>(Channels.handoffQueueList, { projectCwd: h.cwd })
  }
}

const turnStart: ChatEvent = { kind: 'turn-start', turnIds: ['u1'] }

async function threePrompts(h: Harness): Promise<HandoffEnvio[]> {
  const envios = await h.register([
    { conteudo: 'Prompt 1', etapas: ['a'] },
    { conteudo: 'Prompt 2', etapas: ['b', 'c'], estimativas: [20, 25] },
    { conteudo: 'Prompt 3', etapas: ['d'] }
  ])
  // O 1º saiu e está rodando: o 2º e o 3º esperam.
  await h.tracker.dispatched(CONV, envios[0].id)
  h.tracker.noteUserSend(CONV, 'Prompt 1')
  h.emit(turnStart)
  await h.settle()
  return envios
}

describe('a faixa "Próximos prompts" — ações nos prompts que esperam', () => {
  it('o item traz as etapas, o "de N", a estimativa e o texto', async () => {
    const h = await harness()
    await threePrompts(h)
    const list = await ipc(h).list()
    expect(list).toMatchObject({
      ok: true,
      items: [
        { ordem: 2, totalPrompts: 3, estimativaTotal: 45, conteudo: 'Prompt 2', etapas: [{ id: 'b', titulo: 'Etapa b' }, { id: 'c', titulo: 'Etapa c' }] },
        { ordem: 3, totalPrompts: 3, conteudo: 'Prompt 3', etapas: [{ id: 'd', titulo: 'Etapa d' }] }
      ]
    })
  })

  it('tirar da fila: o envio fica com o motivo, não sai mais, e o seguinte passa à frente', async () => {
    const h = await harness()
    const [, second, third] = await threePrompts(h)
    const q = ipc(h)
    expect(await q.edit({ envioId: second.id, acao: 'tirar' })).toEqual({ ok: true })
    expect(q.changed).toEqual([CONV])
    const envios = await h.envios()
    expect(envios[1]).toMatchObject({ status: 'parada', motivo: HANDOFF_REMOVED_MOTIVO, enviadoEm: null })
    // O 1º concluiu: o próximo a sair é o 3º, nunca o tirado.
    const concluded = envios.map((e, i) => (i === 0 ? { ...e, status: 'concluida' as const } : e))
    expect(decideQueue(concluded)).toMatchObject({ kind: 'next', envio: { id: third.id } })
    // A faixa não mostra mais o tirado, e o "de N" desconta ele.
    expect(await q.list()).toMatchObject({ ok: true, items: [{ envioId: third.id, totalPrompts: 2 }] })
    // Tirar de novo, ou tirar o que já saiu: recusado.
    expect(await q.edit({ envioId: second.id, acao: 'tirar' })).toMatchObject({ ok: false })
    expect(await q.edit({ envioId: envios[0].id, acao: 'tirar' })).toEqual({ ok: false, message: 'Este prompt já saiu da fila.' })
  })

  it('editar: grava o texto (e o hash) do que vai sair; vazio é recusado', async () => {
    const h = await harness()
    const [, second] = await threePrompts(h)
    const q = ipc(h)
    expect(await q.edit({ envioId: second.id, acao: 'editar', conteudo: 'Prompt 2 revisado' })).toEqual({ ok: true })
    const edited = (await h.envios())[1]
    expect(edited.conteudo).toBe('Prompt 2 revisado')
    expect(edited.conteudoHash).not.toBe(second.conteudoHash)
    expect(await q.edit({ envioId: second.id, acao: 'editar', conteudo: '   ' })).toMatchObject({ ok: false })
  })

  it('reordenar: as mesmas posições, na ordem nova; prompt que já saiu ou de outro plano recusa', async () => {
    const h = await harness()
    const [first, second, third] = await threePrompts(h)
    const q = ipc(h)
    expect(await q.reorder([third.id, second.id])).toEqual({ ok: true })
    const envios = await h.envios()
    expect(envios.find((e) => e.id === third.id)?.ordem).toBe(2)
    expect(envios.find((e) => e.id === second.id)?.ordem).toBe(3)
    expect(envios.find((e) => e.id === first.id)?.ordem).toBe(1)
    expect(await q.reorder([second.id, first.id])).toMatchObject({ ok: false })

    // Outro plano na mesma conversa: nunca intercalado.
    const [other] = await h.repo.createHandoffEnvios([
      {
        planSlug: 'outro',
        planTitulo: 'Outro',
        projectId: h.projectId,
        projectCwd: h.cwd,
        conversationId: CONV,
        conversationTitle: 'Implementação',
        arquivo: '2026-10-06-09.md',
        ordem: 1,
        loteId: 'hl-2',
        conteudo: 'Outro prompt',
        entregas: []
      }
    ])
    expect(await q.reorder([other.id, second.id])).toEqual({ ok: false, message: 'Só dá para reordenar os prompts de um mesmo plano.' })
  })
})
