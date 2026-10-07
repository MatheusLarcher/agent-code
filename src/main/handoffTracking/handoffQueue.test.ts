// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { HandoffQueueDispatchedResult, HandoffQueueGateResult, HandoffQueueListResult } from '../../shared/api'
import { Channels, type ChatEvent } from '../../shared/ipc'
import { decideQueue } from './handoffQueue'
import { registerHandoffQueueIpc, type HandoffQueueIpcListener } from './handoffQueueIpc'
import { CONV, closeHarnesses, harness, type Harness } from './handoffTrackerHarness'

/**
 * A fila do quadro de ponta a ponta (tracker, Quadro e SQLite de verdade): o
 * próximo prompt só sai com o anterior concluído; não concluído, a fila para
 * com o motivo do acompanhamento; "Enviar mesmo assim" solta; e a fila anda
 * sozinha quando o anterior conclui depois.
 */

afterEach(closeHarnesses)

const turnStart: ChatEvent = { kind: 'turn-start', turnIds: ['u1'] }
const result: ChatEvent = { kind: 'result', id: 'r1', isError: false, text: 'Pronto.', durationMs: 1 }

function ipc(h: Harness) {
  const handlers = new Map<string, HandoffQueueIpcListener>()
  registerHandoffQueueIpc({ handle: (channel, listener) => handlers.set(channel, listener), repository: () => h.repo, tracker: h.tracker })
  const call = <T>(channel: string, payload?: unknown): Promise<T> => Promise.resolve(handlers.get(channel)!(null, payload) as T)
  return {
    gate: (force?: boolean) => call<HandoffQueueGateResult>(Channels.handoffQueueGate, { conversationId: CONV, ...(force ? { force } : {}) }),
    dispatched: (envioId: string) => call<HandoffQueueDispatchedResult>(Channels.handoffQueueDispatched, { conversationId: CONV, envioId }),
    list: (projectCwd?: string) => call<HandoffQueueListResult>(Channels.handoffQueueList, projectCwd ? { projectCwd } : {})
  }
}

/** Um turno do agente: o prompt sai (texto), as tarefas `[etapa]` e o fim do turno. */
async function turn(h: Harness, prompt: string | null, tasks: Array<[string, 'pending' | 'in_progress' | 'completed']>): Promise<void> {
  if (prompt) h.tracker.noteUserSend(CONV, prompt)
  h.advance(1_000)
  h.emit(turnStart)
  h.tasks(tasks)
  h.advance(1_000)
  h.emit(result)
  await h.settle()
}

describe('fila do quadro — o despachante (handoffQueue)', () => {
  it('nada saiu ainda: a fila não solta nada (o 1º prompt é do diálogo de envio)', async () => {
    const h = await harness()
    await h.register([{ conteudo: 'Prompt 1', etapas: ['a'] }, { conteudo: 'Prompt 2', etapas: ['b'] }])
    expect(decideQueue(await h.envios())).toEqual({ kind: 'none' })
    expect(await ipc(h).gate(true)).toEqual({ ok: true, decision: { kind: 'none' } })
  })

  it('anterior concluído → o próximo sai, marcado pelo id (uma vez só)', async () => {
    const h = await harness()
    const [, second] = await h.register([
      { conteudo: 'Prompt 1', etapas: ['a'] },
      { conteudo: 'Prompt 2', etapas: ['b'] },
      { conteudo: 'Prompt 3', etapas: ['c'] }
    ])
    await turn(h, 'Prompt 1', [['[a] Etapa a', 'completed']])
    expect((await h.envios())[0].status).toBe('concluida')

    const q = ipc(h)
    const gate = await q.gate()
    expect(gate).toMatchObject({ ok: true, decision: { kind: 'next', envio: { id: second.id, conteudo: 'Prompt 2', ordem: 2 } } })
    expect(await q.dispatched(second.id)).toEqual({ ok: true, dispatched: true })
    expect(await q.dispatched(second.id)).toEqual({ ok: true, dispatched: false })
    expect((await h.envios())[1]).toMatchObject({ status: 'enviado', enviadoEm: expect.any(String) })
    // O texto que sai depois não "casa" de novo pelo hash: ele já saiu pelo id.
    h.tracker.noteUserSend(CONV, 'Prompt 2')
    await h.settle()
    expect((await h.envios()).map((e) => e.status)).toEqual(['concluida', 'enviado', 'na_fila'])
  })

  it('anterior não concluído → para com o motivo; "Enviar mesmo assim" solta; e anda sozinha quando ele conclui', async () => {
    const h = await harness()
    const [, second, third] = await h.register([
      { conteudo: 'Prompt 1', etapas: ['a'] },
      { conteudo: 'Prompt 2', etapas: ['b'] },
      { conteudo: 'Prompt 3', etapas: ['c'] }
    ])
    const q = ipc(h)
    await turn(h, 'Prompt 1', [['[a] Etapa a', 'completed']])
    await q.dispatched(second.id)
    await turn(h, null, [
      ['[a] Etapa a', 'completed'],
      ['[b] Etapa b', 'in_progress']
    ])
    expect((await h.envios())[1].status).toBe('incompleta')

    const held = await q.gate()
    expect(held).toMatchObject({ ok: true, decision: { kind: 'hold', envio: { id: third.id } } })
    if (!held.ok || held.decision.kind !== 'hold') throw new Error('esperava parada')
    expect(held.decision.motivo).toMatch(/^o prompt anterior não foi concluído: /)
    expect(held.decision.motivo).toContain('[b]')

    // A faixa "Próximos prompts" vê a mesma parada.
    const list = await q.list(h.cwd)
    expect(list).toMatchObject({ ok: true, items: [{ envioId: third.id, estado: 'parada', motivo: held.decision.motivo, ordem: 3 }] })

    // "Enviar mesmo assim": solta mesmo com o anterior incompleto.
    expect(await q.gate(true)).toMatchObject({ ok: true, decision: { kind: 'next', envio: { id: third.id } } })

    // O cartão da etapa b conclui depois (o agente terminou numa mensagem seguinte):
    // o envio 2 vira concluído e a fila anda sozinha.
    h.tasks([
      ['[a] Etapa a', 'completed'],
      ['[b] Etapa b', 'completed']
    ])
    await h.settle()
    expect((await h.envios())[1].status).toBe('concluida')
    expect(await q.gate()).toMatchObject({ ok: true, decision: { kind: 'next', envio: { id: third.id } } })
  })

  it('a lista filtra pela pasta deste PC (outro caminho não entra)', async () => {
    const h = await harness()
    await h.register([{ conteudo: 'Prompt 1', etapas: ['a'] }, { conteudo: 'Prompt 2', etapas: ['b'] }])
    await turn(h, 'Prompt 1', [['[a] Etapa a', 'in_progress']])
    const q = ipc(h)
    expect(await q.list('C:\\outra\\pasta')).toEqual({ ok: true, items: [] })
    // No Windows, a mesma pasta escrita com outra caixa é a mesma pasta.
    const sameFolder = process.platform === 'win32' ? h.cwd.toUpperCase() : h.cwd
    expect(await q.list(sameFolder)).toMatchObject({ ok: true, items: [{ ordem: 2 }] })
    expect(await q.list()).toMatchObject({ ok: true, items: [{ ordem: 2 }] })
  })
})
