// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HANDOFF_REMOVED_MOTIVO } from '../../shared/handoffTracking'
import type { ChatEvent, TaskItem } from '../../shared/ipc'
import { HANDOFF_STALL_MS } from './handoffRules'
import { iso } from './handoffTestKit'
import { CONV, closeHarnesses, harness, type Harness } from './handoffTrackerHarness'

// O reconciliador central (handoffReconcile.ts): as entregas e os envios que JÁ
// saíram acompanham o Quadro do PROJETO — depois de reiniciar, com o trabalho
// feito noutra conversa, e também para envio incompleto, parado ou que falhou.

afterEach(closeHarnesses)

const OTHER = 'conv-outra'
const turnStart = (id = 'u1'): ChatEvent => ({ kind: 'turn-start', turnIds: [id] })
const result = (over: Partial<Extract<ChatEvent, { kind: 'result' }>> = {}): ChatEvent => ({
  kind: 'result',
  id: 'r1',
  isError: false,
  text: 'Pronto.',
  durationMs: 1,
  ...over
})

async function running(etapas: string[]): Promise<Harness> {
  const h = await harness()
  await h.register([{ conteudo: 'Prompt 1', etapas }])
  h.tracker.noteUserSend(CONV, 'Prompt 1')
  h.emit(turnStart())
  await h.settle()
  return h
}

/** O PO conclui o cartão da etapa — o veredito chega pelo Quadro. */
async function poConclui(h: Harness, prefix: string, conv = CONV): Promise<void> {
  await h.board.applyPo({ id: (await h.cardOf(prefix, conv)).id, poStatus: 'completed', poReason: 'está pronto', actor: 'po' })
  await h.settle()
}

/** O app fechado: o que muda no Quadro não chega a acompanhamento nenhum. */
function closeApp(h: Harness): void {
  h.tracker.boardChanged = () => undefined
}

function taskList(list: string, items: Array<[string, TaskItem['status']]>): ChatEvent {
  return {
    kind: 'task-list',
    list,
    items: items.map(([content, status], index) => ({ id: String(index + 1), content, status, activeForm: content }))
  }
}

describe('reconciliador — depois de reiniciar', () => {
  it('incompleta vira concluída quando o cartão conclui DEPOIS de reiniciar (tracker novo, sem estado em memória)', async () => {
    const h = await running(['a'])
    h.tasks([['[a] Fazer A', 'in_progress']])
    h.emit(result())
    await h.settle()
    expect((await h.envios())[0].status).toBe('incompleta')

    h.reopen()
    h.advance(60_000)
    await poConclui(h, '[a]')
    const [envio] = await h.envios()
    expect(envio).toMatchObject({ status: 'concluida', motivo: null, concluidoEm: iso(h.now()) })
    expect(envio.entregas[0].status).toBe('concluida')
    expect(h.changed).toContain(CONV)
  })

  it('no boot, uma passada por projeto: o cartão que concluiu com o app fechado conclui o envio', async () => {
    const h = await running(['a'])
    h.tasks([['[a] Fazer A', 'in_progress']])
    h.emit(result())
    await h.settle()
    closeApp(h)
    await poConclui(h, '[a]')
    expect((await h.envios())[0].status).toBe('incompleta')

    const tracker = h.reopen()
    await expect(tracker.loadKnown()).resolves.toBe(true)
    await h.settle()
    expect((await h.envios())[0]).toMatchObject({ status: 'concluida', motivo: null })
  })

  it('cartão concluído e DISPENSADO (a expiração de 2 dias) continua valendo', async () => {
    const h = await running(['a', 'b'])
    h.tasks([
      ['[a] Fazer A', 'in_progress'],
      ['[b] Fazer B', 'completed']
    ])
    h.emit(result())
    await h.settle()
    expect((await h.envios())[0].status).toBe('incompleta')
    closeApp(h)
    const [a, b] = [await h.cardOf('[a]'), await h.cardOf('[b]')]
    await poConclui(h, '[a]')
    await h.board.dismiss(a.id, true)
    await h.board.dismiss(b.id, true)

    const tracker = h.reopen()
    await tracker.loadKnown()
    await h.settle()
    const [envio] = await h.envios()
    expect(envio.status).toBe('concluida')
    expect(envio.entregas.map((e) => [e.status, e.boardItemId])).toEqual([
      ['concluida', a.id],
      ['concluida', b.id]
    ])
  })
})

describe('reconciliador — o Quadro do projeto inteiro', () => {
  it('o cartão feito noutra conversa do mesmo projeto conta', async () => {
    const h = await running(['a'])
    h.emit(result())
    await h.settle()
    expect((await h.envios())[0]).toMatchObject({ status: 'incompleta', motivo: expect.stringMatching(/sem cartão/) })

    h.tasks([['[a] Fazer A', 'completed']], OTHER)
    await h.settle()
    const [envio] = await h.envios()
    expect(envio).toMatchObject({ status: 'concluida', motivo: null })
    expect(envio.entregas[0]).toMatchObject({ status: 'concluida', boardItemId: (await h.cardOf('[a]', OTHER)).id })
  })

  it('cartão novo pendente com o mesmo prefixo (lista nova ao retomar) não regride a etapa concluída', async () => {
    const h = await running(['a', 'b'])
    h.tasks([
      ['[a] Fazer A', 'completed'],
      ['[b] Fazer B', 'pending']
    ])
    h.emit(result())
    await h.settle()
    expect((await h.envios())[0].entregas[0].status).toBe('concluida')

    // O usuário retoma e o agente monta uma lista NOVA com os mesmos prefixos.
    h.tracker.noteUserSend(CONV, 'continue')
    h.emit(turnStart('u2'))
    h.emit(
      taskList('retomada', [
        ['[a] Fazer A', 'pending'],
        ['[b] Fazer B', 'completed']
      ])
    )
    await h.settle()
    let [envio] = await h.envios()
    expect(envio.entregas.map((e) => e.status)).toEqual(['concluida', 'concluida'])
    h.emit(result())
    await h.settle()
    ;[envio] = await h.envios()
    expect(envio.status).toBe('concluida')
    expect(envio.entregas[0].status).toBe('concluida')
  })

  it('rajada de mudanças no Quadro: uma leitura do projeto, e só avisa a conversa que mudou', async () => {
    const h = await running(['a'])
    h.emit(result())
    await h.settle()
    const list = vi.spyOn(h.repo, 'listHandoffEnvios')
    h.changed.length = 0
    for (let i = 0; i < 5; i++) h.tracker.boardChanged(h.projectId)
    await h.settle()
    expect(list.mock.calls.filter(([query]) => query.projectIds !== undefined)).toHaveLength(1)
    expect(h.changed).toEqual([])
  })
})

describe('reconciliador — envio incompleto, parado ou que falhou', () => {
  it('turno que terminou com ERRO conclui quando tudo fica pronto no Quadro', async () => {
    const h = await running(['a'])
    h.tasks([['[a] Fazer A', 'in_progress']])
    h.emit(result({ isError: true, text: 'error_during_execution' }))
    await h.settle()
    expect((await h.envios())[0]).toMatchObject({ status: 'incompleta', motivo: expect.stringMatching(/^o turno terminou com erro/) })
    await poConclui(h, '[a]')
    expect((await h.envios())[0]).toMatchObject({ status: 'concluida', motivo: null, concluidoEm: iso(h.now()) })
  })

  it('falhou (erro de verdade) também conclui quando a última etapa fica pronta', async () => {
    const h = await running(['a'])
    h.tasks([['[a] Fazer A', 'in_progress']])
    h.emit({ kind: 'error', id: 'e1', text: 'Agent stopped: boom' })
    await h.settle()
    expect((await h.envios())[0].status).toBe('falhou')
    await poConclui(h, '[a]')
    expect((await h.envios())[0]).toMatchObject({ status: 'concluida', motivo: null })
  })

  it('incompleta com erro que ainda falta: o erro fica e só a lista do que falta é relida', async () => {
    const h = await running(['a', 'b'])
    h.tasks([
      ['[a] Fazer A', 'in_progress'],
      ['[b] Fazer B', 'pending']
    ])
    h.emit(result({ isError: true, text: 'error_during_execution' }))
    await h.settle()
    expect((await h.envios())[0].motivo).toMatch(/^o turno terminou com erro: error_during_execution — faltou 2 de 2 entregas/)
    await poConclui(h, '[a]')
    expect((await h.envios())[0]).toMatchObject({
      status: 'incompleta',
      motivo: 'o turno terminou com erro: error_during_execution — faltou 1 de 2 entregas: [b] Etapa b — cartão a fazer'
    })
  })

  it('parada que já saiu conclui; o "tirado da fila" não é tocado', async () => {
    const h = await harness()
    await h.register([
      { conteudo: 'Prompt 1', etapas: ['a'] },
      { conteudo: 'Prompt 2', etapas: ['b'] }
    ])
    h.tracker.noteUserSend(CONV, 'Prompt 1')
    await h.settle()
    const removed = (await h.envios())[1]
    await h.repo.updateHandoffEnvio(removed.id, { status: 'parada', motivo: HANDOFF_REMOVED_MOTIVO })
    h.advance(HANDOFF_STALL_MS)
    await h.tracker.sweep()
    expect((await h.envios())[0]).toMatchObject({ status: 'parada', enviadoEm: expect.any(String) })

    h.tasks(
      [
        ['[a] Fazer A', 'completed'],
        ['[b] Fazer B', 'completed']
      ],
      OTHER
    )
    await h.settle()
    const [first, second] = await h.envios()
    expect(first).toMatchObject({ status: 'concluida', motivo: null })
    expect(second).toMatchObject({ status: 'parada', motivo: HANDOFF_REMOVED_MOTIVO })
    expect(second.entregas[0]).toMatchObject({ status: 'pendente', boardItemId: null })
  })

  it('entrega corrigida pelo usuário fica intocada; o envio diz o que ainda falta', async () => {
    const h = await running(['a', 'b'])
    h.tasks([
      ['[a] Fazer A', 'pending'],
      ['[b] Fazer B', 'completed']
    ])
    h.emit(result())
    await h.settle()
    const [before] = await h.envios()
    await h.tracker.correctEntrega({ entregaId: before.entregas[1].id, acao: 'reabrir', motivo: 'refazer' })
    await poConclui(h, '[a]')
    const [envio] = await h.envios()
    expect(envio.entregas[0].status).toBe('concluida')
    expect(envio.entregas[1]).toMatchObject({ status: 'pendente', corrigidoPor: 'usuario', motivo: 'corrigido por você: refazer' })
    expect(envio).toMatchObject({ status: 'incompleta', motivo: 'faltou 1 de 2 entregas: [b] Etapa b — corrigido por você: refazer' })
  })

  it('turno rodando na conversa: as entregas acompanham, o status do envio não muda', async () => {
    const h = await harness()
    await h.register([
      { conteudo: 'Prompt 1', etapas: ['a'] },
      { conteudo: 'Prompt 2', etapas: ['b'] }
    ])
    h.tracker.noteUserSend(CONV, 'Prompt 1')
    h.emit(turnStart())
    h.tasks([
      ['[a] Fazer A', 'in_progress'],
      ['[b] Fazer B', 'pending']
    ])
    h.emit(result())
    await h.settle()
    expect((await h.envios())[0].status).toBe('incompleta')

    h.advance(1_000)
    h.tracker.noteUserSend(CONV, 'Prompt 2')
    h.emit(turnStart('u2'))
    await h.settle()
    await poConclui(h, '[a]')
    let [first, second] = await h.envios()
    expect(first.entregas[0].status).toBe('concluida')
    expect(first.status).toBe('incompleta')
    expect(second.status).toBe('em_execucao')

    h.emit(result())
    await h.settle()
    h.tracker.boardChanged(h.projectId)
    await h.settle()
    ;[first, second] = await h.envios()
    expect(first.status).toBe('concluida')
  })
})

describe('reconciliador — trava de época (marco: o registro do lote)', () => {
  it('[c] declarado no turno do prompt 1 (antes de o prompt 3 sair) conclui a entrega do prompt 3', async () => {
    const h = await harness()
    await h.register([
      { conteudo: 'Prompt 1', etapas: ['a'] },
      { conteudo: 'Prompt 2', etapas: ['b'] },
      { conteudo: 'Prompt 3', etapas: ['c'] }
    ])
    const turn = async (prompt: string, id: string, tasks: Array<[string, TaskItem['status']]>): Promise<void> => {
      h.advance(10 * 60_000)
      h.tracker.noteUserSend(CONV, prompt)
      h.emit(turnStart(id))
      h.tasks(tasks)
      h.emit(result())
      await h.settle()
    }
    // O agente declara o roteiro inteiro já no 1º prompt.
    await turn('Prompt 1', 'u1', [
      ['[a] Fazer A', 'completed'],
      ['[b] Fazer B', 'pending'],
      ['[c] Fazer C', 'pending']
    ])
    const c = await h.cardOf('[c]')
    await turn('Prompt 2', 'u2', [
      ['[a] Fazer A', 'completed'],
      ['[b] Fazer B', 'completed'],
      ['[c] Fazer C', 'pending']
    ])
    await turn('Prompt 3', 'u3', [
      ['[a] Fazer A', 'completed'],
      ['[b] Fazer B', 'completed'],
      ['[c] Fazer C', 'completed']
    ])

    const third = (await h.envios())[2]
    // O cartão nasceu antes de o prompt 3 sair — e depois do registro do lote.
    expect(Date.parse(c.createdAt)).toBeLessThan(Date.parse(third.enviadoEm!) - 60_000)
    expect(Date.parse(c.createdAt)).toBeGreaterThanOrEqual(Date.parse(third.criadoEm))
    expect((await h.envios()).map((e) => e.status)).toEqual(['concluida', 'concluida', 'concluida'])
    expect(third.entregas[0]).toMatchObject({ status: 'concluida', boardItemId: c.id })
  })

  it('cartão [a] concluído de um lote registrado ANTES do atual (inclusive dispensado) não conclui a etapa do envio novo', async () => {
    const h = await harness()
    // O plano anterior, 10 min antes no relógio do banco (o `Date` com que o
    // SQLite carimba) — só durante a escrita do cartão dele.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 10 * 60_000 })
    try {
      h.tasks([['[a] Do plano anterior', 'completed']], OTHER)
      await h.settle()
    } finally {
      vi.useRealTimers()
    }
    const old = await h.cardOf('[a]', OTHER)
    await h.board.dismiss(old.id, true)

    await h.register([{ conteudo: 'Prompt 1', etapas: ['a'] }])
    expect(Date.parse(old.createdAt)).toBeLessThan(Date.parse((await h.envios())[0].criadoEm) - 60_000)
    h.tracker.noteUserSend(CONV, 'Prompt 1')
    h.emit(turnStart())
    h.emit(result())
    await h.settle()
    let [envio] = await h.envios()
    expect(envio).toMatchObject({ status: 'incompleta', motivo: expect.stringContaining('sem cartão no Quadro com o prefixo [a]') })
    expect(envio.entregas[0]).toMatchObject({ status: 'incompleta', boardItemId: null })

    // O cartão do plano NOVO conclui.
    h.tasks([['[a] Fazer A', 'completed']])
    await h.settle()
    ;[envio] = await h.envios()
    expect(envio).toMatchObject({ status: 'concluida', motivo: null })
    expect(envio.entregas[0].boardItemId).toBe((await h.cardOf('[a]')).id)
  })
})

describe('reconciliador — varredura e custo', () => {
  const DAY = 24 * 60 * 60_000

  it('envio em execução com tudo pronto no Quadro vira parada pela varredura e a passada seguinte o conclui, sem nova mudança no Quadro', async () => {
    const h = await running(['a'])
    h.tasks([['[a] Fazer A', 'completed']])
    await h.settle()
    expect((await h.envios())[0]).toMatchObject({ status: 'em_execucao', entregas: [expect.objectContaining({ status: 'concluida' })] })

    // O app fechou no meio do turno: o `result` nunca chega.
    const tracker = h.reopen()
    await tracker.loadKnown()
    await h.settle()
    expect((await h.envios())[0].status).toBe('em_execucao')

    h.advance(HANDOFF_STALL_MS)
    await expect(tracker.sweep()).resolves.toMatchObject({ stalled: 1 })
    await h.settle()
    expect((await h.envios())[0]).toMatchObject({ status: 'concluida', motivo: null, concluidoEm: iso(h.now()) })
  })

  it('mudança no Quadro: os cartões do projeto são listados UMA vez por passada, com várias conversas', async () => {
    const h = await harness()
    await h.register([{ conteudo: 'Prompt 1', etapas: ['a'] }])
    await h.register([{ conteudo: 'Prompt O', etapas: ['o'] }], OTHER)
    h.tracker.noteUserSend(CONV, 'Prompt 1')
    h.tracker.noteUserSend(OTHER, 'Prompt O')
    h.emit(result())
    h.emit(result(), OTHER)
    await h.settle()
    expect([(await h.envios())[0].status, (await h.envios(OTHER))[0].status]).toEqual(['incompleta', 'incompleta'])

    const list = vi.spyOn(h.board, 'list')
    h.tracker.boardChanged(h.projectId)
    await h.settle()
    expect(list).toHaveBeenCalledTimes(1)
  })

  it.each([
    [29, 'concluida'],
    [31, 'incompleta']
  ])('mudança no Quadro só relê envio com atividade nos últimos 30 dias (%i dias → %s); o boot relê todos', async (days, status) => {
    const h = await running(['a'])
    h.tasks([['[a] Fazer A', 'in_progress']])
    h.emit(result())
    await h.settle()
    const [incompleta] = await h.envios()
    expect(incompleta.status).toBe('incompleta')

    // A idade é do `updatedAt` (relógio do banco) até o relógio do tracker.
    h.advance(days * DAY - (h.now() - Date.parse(incompleta.updatedAt)))
    await poConclui(h, '[a]')
    expect((await h.envios())[0].status).toBe(status)

    const tracker = h.reopen()
    await tracker.loadKnown()
    await h.settle()
    expect((await h.envios())[0]).toMatchObject({ status: 'concluida', motivo: null })
  })
})
