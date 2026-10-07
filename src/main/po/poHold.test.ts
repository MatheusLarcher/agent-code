// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandoffQueueGateResult, HandoffQueueListResult } from '../../shared/api'
import { HANDOFF_PO_HOLD_PREFIX } from '../../shared/handoffTracking'
import { Channels, type BoardItem, type ChatEvent } from '../../shared/ipc'
import { editQueued, holdQueued, nextQueuedPrompt } from '../handoffTracking/handoffQueueEdit'
import { registerHandoffQueueIpc, type HandoffQueueIpcListener } from '../handoffTracking/handoffQueueIpc'
import { CONV, closeHarnesses, harness, type Harness } from '../handoffTracking/handoffTrackerHarness'
import { applyPoVerdict, type PoApplyDeps } from './poApply'
import { isReadablePoVerdict } from './poCloseDefault'
import { formatPoNextPrompt, parsePoHold } from './poHold'
import { buildPoRequest } from './poRequest'

/**
 * O PO segura a fila quando o próximo prompt ficou velho: o resumo do próximo
 * envio vai no digest do fechamento, `SEGURAR | <motivo>` vem no mesmo
 * veredito, e o despachante para nele até o usuário decidir (enviar mesmo
 * assim, editar ou tirar). Falha aberta: sem veredito, a regra decide.
 */

afterEach(closeHarnesses)

describe('o veredito: SEGURAR | <motivo>', () => {
  it('válido só com motivo; sem motivo é descartado; a última linha vale', () => {
    expect(parsePoHold('OK\nSEGURAR | a etapa 2 já criou o endpoint que o prompt 3 manda criar')).toBe(
      'a etapa 2 já criou o endpoint que o prompt 3 manda criar'
    )
    expect(parsePoHold('**SEGURAR** | o agente mudou a API')).toBe('o agente mudou a API')
    expect(parsePoHold('SEGURAR |   ')).toBeNull()
    expect(parsePoHold('SEGURAR')).toBeNull()
    expect(parsePoHold('CONCLUIR c1 | feito')).toBeNull()
    expect(parsePoHold('SEGURAR | primeiro\nSEGURAR | segundo')).toBe('segundo')
    // Um veredito só com SEGURAR continua legível (a conclusão padrão vale).
    expect(isReadablePoVerdict('SEGURAR | motivo')).toBe(true)
  })

  it('o resumo do próximo prompt entra só no digest do FECHAMENTO, nunca o texto inteiro', () => {
    const next = { envioId: 'e3', summary: 'Prompt 3 de 4 do plano "P" (03.md) — etapas: [x] Criar endpoint' }
    const base = {
      config: { po: { model: 'm' } } as never,
      convId: 'c',
      cwd: 'C:/p',
      projectId: 'p',
      cards: [],
      userText: 'oi',
      calls: [],
      ledgerTasks: [],
      background: [],
      returned: [],
      correlationId: 'x',
      next
    }
    expect(buildPoRequest({ ...base, phase: 'close' }).prompt).toContain(formatPoNextPrompt(next))
    expect(buildPoRequest({ ...base, phase: 'open' }).prompt).not.toContain('PRÓXIMO PROMPT DA FILA')
    expect(formatPoNextPrompt(next)).toContain('Na dúvida, não segure')
  })

  it('poApply: SEGURAR só no fechamento e só com o próximo prompt que o digest mostrou', async () => {
    const holdNext = vi.fn(async () => undefined)
    const deps = { board: { list: vi.fn(async () => []), applyPo: vi.fn(), createPoItem: vi.fn() }, holdNext } as unknown as PoApplyDeps
    const target = { convId: 'c', cwd: 'C:/p', projectId: 'p', startedAt: 0, returned: [] as BoardItem[] }
    const progress = { applied: 0, touched: [] as string[] }
    const next = { envioId: 'e3', summary: 'Prompt 3' }
    await applyPoVerdict(deps, { ...target, phase: 'close', next }, 'SEGURAR | o agente já fez isso', [], progress)
    expect(holdNext).toHaveBeenCalledWith('e3', 'o agente já fez isso')
    await applyPoVerdict(deps, { ...target, phase: 'close', next: null }, 'SEGURAR | sem próximo', [], progress)
    await applyPoVerdict(deps, { ...target, phase: 'open', next }, 'SEGURAR | na abertura', [], progress)
    await applyPoVerdict(deps, { ...target, phase: 'close', next }, 'OK', [], progress)
    expect(holdNext).toHaveBeenCalledTimes(1)
  })
})

const turnStart: ChatEvent = { kind: 'turn-start', turnIds: ['u1'] }
const ok: ChatEvent = { kind: 'result', id: 'r1', isError: false, text: 'Pronto.', durationMs: 1 }

function gate(h: Harness) {
  const handlers = new Map<string, HandoffQueueIpcListener>()
  registerHandoffQueueIpc({ handle: (c, l) => handlers.set(c, l), repository: () => h.repo, tracker: h.tracker })
  return {
    gate: (force?: boolean) =>
      Promise.resolve(handlers.get(Channels.handoffQueueGate)!(null, { conversationId: CONV, ...(force ? { force } : {}) }) as HandoffQueueGateResult),
    list: () => Promise.resolve(handlers.get(Channels.handoffQueueList)!(null, {}) as HandoffQueueListResult)
  }
}

/** O 1º prompt saiu e concluiu: o 2º é o próximo. */
async function firstDone(h: Harness) {
  const envios = await h.register([
    { conteudo: 'Prompt 1', etapas: ['a'] },
    { conteudo: 'Prompt 2', etapas: ['b'] }
  ])
  await h.tracker.dispatched(CONV, envios[0].id)
  h.tracker.noteUserSend(CONV, 'Prompt 1')
  h.emit(turnStart)
  h.tasks([['[a] Etapa a', 'completed']])
  h.emit(ok)
  await h.settle()
  return envios
}

describe('o despachante com o prompt segurado', () => {
  it('segurado → a fila para com o motivo ("segurada" na faixa); "Enviar mesmo assim" solta; editar destrava', async () => {
    const h = await harness()
    const [, second] = await firstDone(h)
    const deps = { repository: () => h.repo, changed: vi.fn() }
    expect(await nextQueuedPrompt(h.repo, CONV)).toEqual({ envioId: second.id, summary: 'Prompt 2 de 2 do plano "Plano" (2026-10-05-02.md) — etapas: [b] Etapa b' })
    expect(await holdQueued(deps, second.id, 'a etapa 1 já fez o que o prompt 2 manda')).toBe(true)
    expect(deps.changed).toHaveBeenCalledWith(CONV)

    const q = gate(h)
    expect(await q.gate()).toEqual({
      ok: true,
      decision: { kind: 'hold', envio: expect.objectContaining({ id: second.id }), motivo: `${HANDOFF_PO_HOLD_PREFIX}a etapa 1 já fez o que o prompt 2 manda` }
    })
    expect(await q.list()).toMatchObject({ ok: true, items: [{ estado: 'segurada', motivo: 'a etapa 1 já fez o que o prompt 2 manda' }] })
    expect(await q.gate(true)).toMatchObject({ decision: { kind: 'next', envio: { id: second.id } } })

    expect(await editQueued(deps, second.id, 'Prompt 2 acertado')).toEqual({ ok: true })
    expect(await q.gate()).toMatchObject({ decision: { kind: 'next', envio: { id: second.id, conteudo: 'Prompt 2 acertado' } } })
  })

  it('falha do PO (nada segurado) → a regra decide sozinha; prompt que já saiu não é segurado', async () => {
    const h = await harness()
    const [first, second] = await firstDone(h)
    expect(await gate(h).gate()).toMatchObject({ decision: { kind: 'next', envio: { id: second.id } } })
    const deps = { repository: () => h.repo, changed: vi.fn() }
    expect(await holdQueued(deps, first.id, 'veredito atrasado')).toBe(false)
    expect(await holdQueued(deps, second.id, '   ')).toBe(false)
  })
})
