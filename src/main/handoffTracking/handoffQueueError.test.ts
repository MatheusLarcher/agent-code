// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { HandoffQueueGateResult } from '../../shared/api'
import { Channels, type ChatEvent } from '../../shared/ipc'
import { registerHandoffQueueIpc, STOP_HOLD_REASON, type HandoffQueueIpcListener } from './handoffQueueIpc'
import { STOP_MOTIVO } from './handoffRules'
import { CONV, closeHarnesses, harness, type Harness } from './handoffTrackerHarness'

/**
 * Erro e Stop na fila do quadro (tracker, Quadro e SQLite de verdade): um turno
 * que termina com erro NUNCA solta o próximo prompt — nem o erro que chega
 * depois de texto —; a retomada que termina bem solta; e o Stop do usuário não
 * é erro: a fila fica parada (sem retomada) até ele retomar ou mandar seguir.
 */

afterEach(closeHarnesses)

const turnStart: ChatEvent = { kind: 'turn-start', turnIds: ['u1'] }
const ok: ChatEvent = { kind: 'result', id: 'r1', isError: false, text: 'Pronto.', durationMs: 1 }

function gate(h: Harness) {
  const handlers = new Map<string, HandoffQueueIpcListener>()
  registerHandoffQueueIpc({ handle: (channel, listener) => handlers.set(channel, listener), repository: () => h.repo, tracker: h.tracker })
  return (force?: boolean): Promise<HandoffQueueGateResult> =>
    Promise.resolve(handlers.get(Channels.handoffQueueGate)!(null, { conversationId: CONV, ...(force ? { force } : {}) }) as HandoffQueueGateResult)
}

/** O 1º prompt saiu (pelo id) e o turno dele começou com a etapa [a] em andamento. */
async function running(h: Harness): Promise<void> {
  const [first] = await h.register([{ conteudo: 'Prompt 1', etapas: ['a'] }, { conteudo: 'Prompt 2', etapas: ['b'] }])
  await h.tracker.dispatched(CONV, first.id)
  h.tracker.noteUserSend(CONV, 'Prompt 1')
  h.advance(1_000)
  h.emit(turnStart)
  h.tasks([['[a] Etapa a', 'in_progress']])
  await h.settle()
}

async function end(h: Harness, event: ChatEvent, done = false): Promise<void> {
  if (done) h.tasks([['[a] Etapa a', 'completed']])
  h.advance(1_000)
  h.emit(event)
  await h.settle()
}

describe('erro na implantação: nunca o próximo prompt', () => {
  it('result com erro depois de texto (mesmo com a etapa concluída): o envio não conclui e a fila para com o erro', async () => {
    const h = await harness()
    await running(h)
    await end(h, { kind: 'result', id: 'r1', isError: true, text: 'API Error: 500 overloaded', durationMs: 1 }, true)
    const first = (await h.envios())[0]
    expect(first.status).toBe('incompleta')
    expect(first.motivo).toContain('API Error: 500 overloaded')
    const res = await gate(h)()
    expect(res).toMatchObject({ ok: true, decision: { kind: 'hold' } })
    if (!res.ok || res.decision.kind !== 'hold') throw new Error('esperava parada')
    expect(res.decision.motivo).toContain('API Error: 500 overloaded')
  })

  it('erro de sessão: o envio falha e a fila para; a retomada que termina bem solta o próximo', async () => {
    const h = await harness()
    await running(h)
    await end(h, { kind: 'error', id: 'e1', text: 'a sessão caiu', retryable: true })
    expect((await h.envios())[0]).toMatchObject({ status: 'falhou', motivo: 'a sessão caiu' })
    expect(await gate(h)()).toMatchObject({ decision: { kind: 'hold', motivo: expect.stringContaining('terminou com erro') } })

    // A retomada ("continue de onde parou") é um turno novo do MESMO envio.
    h.tracker.noteUserSend(CONV, 'Continue exatamente de onde parou.')
    h.advance(1_000)
    h.emit(turnStart)
    await end(h, ok, true)
    expect((await h.envios())[0].status).toBe('concluida')
    expect(await gate(h)()).toMatchObject({ decision: { kind: 'next', envio: { conteudo: 'Prompt 2' } } })
  })
})

describe('Stop do usuário: a fila fica parada e não tenta de novo sozinha', () => {
  it('Stop no meio: o envio fica parado (o rabo `error` do fim do stream não vira falha)', async () => {
    const h = await harness()
    await running(h)
    h.tracker.noteStop(CONV)
    await end(h, { kind: 'result', id: 'r1', isError: true, text: 'interrompido', durationMs: 1 })
    await end(h, { kind: 'error', id: 'e1', text: 'stream encerrado' })
    expect((await h.envios())[0]).toMatchObject({ status: 'parada', motivo: STOP_MOTIVO })
    expect(await gate(h)()).toMatchObject({ decision: { kind: 'hold', motivo: STOP_HOLD_REASON } })
  })

  it('Stop com a etapa já concluída: o envio fica concluído, mas a fila espera; "mesmo assim" ou um turno novo soltam', async () => {
    const h = await harness()
    await running(h)
    h.tracker.noteStop(CONV)
    await end(h, ok, true)
    expect((await h.envios())[0].status).toBe('concluida')
    const g = gate(h)
    expect(await g()).toMatchObject({ decision: { kind: 'hold', motivo: STOP_HOLD_REASON } })
    expect(await g(true)).toMatchObject({ decision: { kind: 'next', envio: { conteudo: 'Prompt 2' } } })
    // O usuário retomou (mandou algo): o Stop deixa de valer.
    h.advance(1_000)
    h.emit(turnStart)
    await end(h, ok)
    expect(await g()).toMatchObject({ decision: { kind: 'next', envio: { conteudo: 'Prompt 2' } } })
  })

  it('Stop que pega o prompt antes de o turno começar (sem `result`): o envio fica parado', async () => {
    const h = await harness()
    const [first] = await h.register([{ conteudo: 'Prompt 1', etapas: ['a'] }, { conteudo: 'Prompt 2', etapas: ['b'] }])
    await h.tracker.dispatched(CONV, first.id)
    h.tracker.noteUserSend(CONV, 'Prompt 1')
    h.tracker.noteStop(CONV)
    await h.settle()
    expect((await h.envios())[0]).toMatchObject({ status: 'parada', motivo: STOP_MOTIVO })
    expect(await gate(h)()).toMatchObject({ decision: { kind: 'hold', motivo: STOP_HOLD_REASON } })
  })
})
