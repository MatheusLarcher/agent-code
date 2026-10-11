// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { HandoffQueueDispatchedResult, HandoffQueueGateResult, HandoffQueueListResult } from '../../shared/api'
import { Channels, type ChatEvent } from '../../shared/ipc'
import { decideQueue, incompleteHeader } from './handoffQueue'
import { resetResumes, resumeCount } from './handoffResumes'
import { envio } from './handoffTestKit'
import {
  HANDOFF_PO_HOLD_PREFIX,
  HANDOFF_REMOVED_MOTIVO,
  HANDOFF_RESUME_TEXT,
  HANDOFF_SESSION_ENDED_MOTIVO,
  type HandoffEnvio,
  type HandoffQueueUndispatchResult
} from '../../shared/handoffTracking'
import { STOP_MOTIVO, stallReason } from './handoffRules'
import { isStallMotivo } from '../../shared/handoffTracking'
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
    undispatch: (envioId: string) => call<HandoffQueueUndispatchResult>(Channels.handoffQueueUndispatch, { conversationId: CONV, envioId }),
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

  it('anterior incompleto → o próximo sai sozinho com a pendência na frente; "Enviar mesmo assim" sai sem ela; e anda sozinha quando ele conclui', async () => {
    const h = await harness()
    const [, second, third] = await h.register([
      { conteudo: 'Prompt 1', etapas: ['a'] },
      { conteudo: 'Prompt 2', etapas: ['b'] },
      { conteudo: 'Prompt 3', etapas: ['c'] }
    ])
    const published: string[] = []
    const handlers = new Map<string, HandoffQueueIpcListener>()
    registerHandoffQueueIpc({
      handle: (channel, listener) => handlers.set(channel, listener),
      repository: () => h.repo,
      tracker: h.tracker,
      publishNotice: (_conv, tipo, texto) => published.push(`${tipo}:${texto}`)
    })
    const q = ipc(h)
    await turn(h, 'Prompt 1', [['[a] Etapa a', 'completed']])
    await q.dispatched(second.id)
    await turn(h, null, [
      ['[a] Etapa a', 'completed'],
      ['[b] Etapa b', 'in_progress']
    ])
    const incompleto = (await h.envios())[1]
    expect(incompleto.status).toBe('incompleta')

    const gate = (await handlers.get(Channels.handoffQueueGate)!(null, { conversationId: CONV })) as HandoffQueueGateResult
    expect(gate).toMatchObject({ ok: true, decision: { kind: 'next', envio: { id: third.id } } })
    if (!gate.ok || gate.decision.kind !== 'next') throw new Error('esperava next')
    expect(gate.decision.envio.conteudo.startsWith(`Antes de começar: o envio anterior ficou incompleto — faltou: ${incompleto.motivo}.`)).toBe(true)
    expect(gate.decision.envio.conteudo).toContain('[b]')
    expect(gate.decision.envio.conteudo.endsWith('\n\n---\n\nPrompt 3')).toBe(true)

    // A faixa "Próximos prompts" não mostra parada: a fila segue.
    const list = await q.list(h.cwd)
    expect(list).toMatchObject({ ok: true, items: [{ envioId: third.id, estado: 'esperando', motivo: null, ordem: 3 }] })

    // "Enviar mesmo assim": solta, com o texto do arquivo (sem cabeçalho).
    expect(await q.gate(true)).toMatchObject({ ok: true, decision: { kind: 'next', envio: { id: third.id, conteudo: 'Prompt 3' } } })
    // O despacho confirmado da decisão automática avisa (celular) "saiu sozinho".
    await handlers.get(Channels.handoffQueueGate)!(null, { conversationId: CONV })
    await handlers.get(Channels.handoffQueueDispatched)!(null, { conversationId: CONV, envioId: third.id })
    expect(published).toEqual([`fila:Envio 3/3 saiu sozinho com a pendência do anterior: ${incompleto.motivo}`])
    expect((await h.envios())[2].status).toBe('enviado')
  })

  it('o anterior incompleto conclui depois: a fila anda sozinha, sem cabeçalho', async () => {
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

    // O cartão da etapa b conclui depois (o agente terminou numa mensagem seguinte):
    // o envio 2 vira concluído e a fila anda sozinha.
    h.tasks([
      ['[a] Etapa a', 'completed'],
      ['[b] Etapa b', 'completed']
    ])
    await h.settle()
    expect((await h.envios())[1].status).toBe('concluida')
    expect(await q.gate()).toMatchObject({ ok: true, decision: { kind: 'next', envio: { id: third.id, conteudo: 'Prompt 3' } } })
  })

  it('parada por inatividade: o MESMO envio retoma (sem envio novo, volta a enviado); a 2ª parada segura', async () => {
    resetResumes()
    const h = await harness()
    const [first, second] = await h.register([
      { conteudo: 'Prompt 1', etapas: ['a'] },
      { conteudo: 'Prompt 2', etapas: ['b'] }
    ])
    const q = ipc(h)
    h.tracker.noteUserSend(CONV, 'Prompt 1')
    await h.settle()
    const stall = 'nenhum turno rodando há 10 min, sem pergunta pendente e sem conclusão'
    await h.repo.updateHandoffEnvio(first.id, { status: 'parada', motivo: stall })

    const gate = await q.gate()
    expect(gate).toMatchObject({ ok: true, decision: { kind: 'next', retomada: true, envio: { id: first.id, conteudo: HANDOFF_RESUME_TEXT } } })
    expect(await q.dispatched(first.id)).toEqual({ ok: true, dispatched: true })
    // Repetido (outra conferência): não manda de novo.
    expect(await q.dispatched(first.id)).toEqual({ ok: true, dispatched: false })
    const after = await h.envios()
    expect(after).toHaveLength(2)
    expect(after[0]).toMatchObject({ id: first.id, status: 'enviado', motivo: null })
    expect(after[1]).toMatchObject({ id: second.id, status: 'na_fila' })

    // Parou de novo por inatividade: a fila segura com o motivo.
    await h.repo.updateHandoffEnvio(first.id, { status: 'parada', motivo: stall })
    expect(await q.gate()).toMatchObject({ ok: true, decision: { kind: 'hold', envio: { id: second.id }, motivo: `o prompt anterior parou duas vezes: ${stall}` } })
  })

  it('o despacho do renderer falhou depois da marca: o envio volta à fila; com o turno começado, não desfaz', async () => {
    const h = await harness()
    const [, second] = await h.register([
      { conteudo: 'Prompt 1', etapas: ['a'] },
      { conteudo: 'Prompt 2', etapas: ['b'] }
    ])
    const q = ipc(h)
    await turn(h, 'Prompt 1', [['[a] Etapa a', 'completed']])
    expect(await q.dispatched(second.id)).toEqual({ ok: true, dispatched: true })
    expect((await h.envios())[1]).toMatchObject({ status: 'enviado', enviadoEm: expect.any(String) })
    // O `dispatch` do App lançou: nada saiu. O envio volta como estava e a fila o solta de novo.
    expect(await q.undispatch(second.id)).toEqual({ ok: true, undone: true })
    expect((await h.envios())[1]).toMatchObject({ status: 'na_fila', enviadoEm: null, motivo: null })
    expect(await q.undispatch(second.id)).toEqual({ ok: true, undone: false })
    expect(await q.gate()).toMatchObject({ ok: true, decision: { kind: 'next', envio: { id: second.id } } })

    // Despachado de verdade (o turno começou): desfazer não cabe mais.
    await q.dispatched(second.id)
    h.emit(turnStart)
    await h.settle()
    expect(await q.undispatch(second.id)).toEqual({ ok: true, undone: false })
    expect((await h.envios())[1].status).toBe('em_execucao')
  })

  it('desfazer recusa o envio cujo turno já começou, mesmo com o status ainda `enviado` (turn-start sem gravação, ou `iniciadoEm` de outro processo)', async () => {
    const h = await harness()
    const [, second] = await h.register([
      { conteudo: 'Prompt 1', etapas: ['a'] },
      { conteudo: 'Prompt 2', etapas: ['b'] }
    ])
    const q = ipc(h)
    await turn(h, 'Prompt 1', [['[a] Etapa a', 'completed']])
    // O turn-start do prompt 1 veio ANTES da marca: não conta contra o 2º.
    expect(await q.dispatched(second.id)).toEqual({ ok: true, dispatched: true })
    // Outro processo (banco compartilhado) gravou o início do turno; aqui o status ainda consta `enviado`.
    await h.repo.updateHandoffEnvio(second.id, { iniciadoEm: new Date(h.now() + 1_000).toISOString() })
    expect(await q.undispatch(second.id)).toEqual({ ok: true, undone: false })
    expect((await h.envios())[1]).toMatchObject({ status: 'enviado', enviadoEm: expect.any(String) })

    // De novo, do zero, noutro processo: o turn-start chegou com o banco fora (o job
    // não gravou) e o turno já acabou (o `result` também não gravou).
    await h.repo.updateHandoffEnvio(second.id, { status: 'na_fila', enviadoEm: null, iniciadoEm: null })
    let online = true
    const tracker = h.reopen({ repository: () => (online ? h.repo : null) })
    tracker.attach(CONV, h.cwd)
    expect(await tracker.dispatched(CONV, second.id)).toBe(true)
    online = false
    h.advance(1_000)
    tracker.observe(CONV, h.cwd, turnStart)
    tracker.observe(CONV, h.cwd, result)
    await tracker.settled()
    expect((await h.envios())[1]).toMatchObject({ status: 'enviado', iniciadoEm: null })
    expect(tracker.isTurnRunning(CONV)).toBe(false)
    // O banco voltou: desfazer veria `enviado` sem turno aberto — mas o turn-start depois da marca o segura.
    online = true
    expect(await tracker.undispatched(CONV, second.id)).toBe(false)
    expect((await h.envios())[1].status).toBe('enviado')
  })

  it('a retomada que não saiu: o envio volta a parado por inatividade e a retomada não conta', async () => {
    resetResumes()
    const h = await harness()
    const [first] = await h.register([
      { conteudo: 'Prompt 1', etapas: ['a'] },
      { conteudo: 'Prompt 2', etapas: ['b'] }
    ])
    const q = ipc(h)
    await turn(h, 'Prompt 1', [['[a] Etapa a', 'in_progress']])
    await h.repo.updateHandoffEnvio(first.id, { status: 'parada', motivo: 'nenhum turno rodando há 10 min, sem pergunta pendente e sem conclusão' })
    expect(await q.gate()).toMatchObject({ ok: true, decision: { kind: 'next', retomada: true } })
    await q.dispatched(first.id)
    expect(resumeCount(first.id)).toBe(1)
    expect(await q.undispatch(first.id)).toEqual({ ok: true, undone: true })
    expect((await h.envios())[0]).toMatchObject({ status: 'parada', motivo: HANDOFF_SESSION_ENDED_MOTIVO, enviadoEm: expect.any(String) })
    expect(resumeCount(first.id)).toBe(0)
    // A fila retoma de novo, como se a 1ª tentativa não tivesse existido.
    expect(await q.gate()).toMatchObject({ ok: true, decision: { kind: 'next', retomada: true, envio: { id: first.id } } })
  })
})

describe('decideQueue — a fila segue sozinha (regra pura)', () => {
  const sent = (over: Partial<HandoffEnvio>): HandoffEnvio => envio({ id: 'p1', ordem: 1, status: 'concluida', enviadoEm: '2026-10-10T10:00:00.000Z', ...over })
  const queued = (over: Partial<HandoffEnvio> = {}): HandoffEnvio =>
    envio({ id: 'p2', ordem: 2, status: 'na_fila', enviadoEm: null, iniciadoEm: null, conteudo: 'Prompt 2', ...over })
  const stall = 'o prompt foi enviado, mas nenhum turno começou em 10 min'
  const never = (): number => 0
  const once = (): number => 1

  it('incompleta → next com o cabeçalho e o motivo', () => {
    const d = decideQueue([sent({ status: 'incompleta', motivo: 'faltou 1 de 2 entregas: [b]' }), queued()], { resumeCount: never })
    expect(d).toMatchObject({ kind: 'next', envio: { id: 'p2' } })
    if (d.kind !== 'next') throw new Error('next')
    expect(d.envio.conteudo).toBe(`${incompleteHeader({ motivo: 'faltou 1 de 2 entregas: [b]' })}Prompt 2`)
    expect(d.envio.conteudo.startsWith('Antes de começar: o envio anterior ficou incompleto — faltou: faltou 1 de 2 entregas: [b]. Feche isso primeiro')).toBe(true)
  })

  it('parada por inatividade → next retomada na 1ª; hold na 2ª', () => {
    const list = [sent({ status: 'parada', motivo: stall }), queued()]
    expect(decideQueue(list, { resumeCount: never })).toEqual({
      kind: 'next',
      retomada: true,
      envio: expect.objectContaining({ id: 'p1', conteudo: HANDOFF_RESUME_TEXT })
    })
    expect(decideQueue(list, { resumeCount: once })).toMatchObject({ kind: 'hold', envio: { id: 'p2' }, motivo: expect.stringMatching(/^o prompt anterior parou duas vezes/) })
  })

  it('parada pelo Stop e "tirado da fila" → hold, como hoje', () => {
    expect(decideQueue([sent({ status: 'parada', motivo: STOP_MOTIVO }), queued()], { resumeCount: never })).toMatchObject({ kind: 'hold' })
    expect(decideQueue([sent({ status: 'parada', motivo: HANDOFF_REMOVED_MOTIVO }), queued()], { resumeCount: never })).toMatchObject({ kind: 'hold' })
  })

  it('hold do PO, esperando você e erro → hold; force solta tudo', () => {
    const po = [sent({}), queued({ motivo: `${HANDOFF_PO_HOLD_PREFIX}contradiz a premissa` })]
    expect(decideQueue(po)).toMatchObject({ kind: 'hold', motivo: `${HANDOFF_PO_HOLD_PREFIX}contradiz a premissa` })
    expect(decideQueue([sent({ status: 'aguardando_voce' }), queued()])).toMatchObject({ kind: 'hold' })
    expect(decideQueue([sent({ status: 'falhou' }), queued()])).toMatchObject({ kind: 'hold' })
    for (const list of [po, [sent({ status: 'parada', motivo: stall }), queued()], [sent({ status: 'parada', motivo: STOP_MOTIVO }), queued()]]) {
      expect(decideQueue(list, { force: true, resumeCount: once })).toEqual({ kind: 'next', envio: expect.objectContaining({ id: 'p2', conteudo: 'Prompt 2' }) })
    }
  })

  it('os textos do vigia de inatividade são reconhecidos como inatividade; Stop e "tirado" não', () => {
    const base = { turnRunning: false, pending: false, lastActivityMs: 0, now: 11 * 60_000, limitMs: 10 * 60_000 }
    for (const status of ['na_fila', 'enviado', 'em_execucao', 'aguardando_voce'] as const) {
      const motivo = stallReason(envio({ status, updatedAt: '1970-01-01T00:00:00.000Z' }), base)
      expect(motivo).not.toBeNull()
      expect(isStallMotivo(motivo)).toBe(true)
    }
    expect(isStallMotivo(STOP_MOTIVO)).toBe(false)
    expect(isStallMotivo(HANDOFF_REMOVED_MOTIVO)).toBe(false)
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
