// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOARD_TURN_END_REASON, type ChatEvent } from '../../shared/ipc'
import { CONV, closeHarnesses, harness } from './handoffTrackerHarness'
import { iso } from './handoffTestKit'

// O tracker com o SqliteRepository e o BoardService de verdade: os status dos
// envios e das entregas pelo que o app observa (turnos, perguntas, Quadro, PO).

afterEach(closeHarnesses)

const turnStart: ChatEvent = { kind: 'turn-start', turnIds: ['u1'] }
const result = (over: Partial<Extract<ChatEvent, { kind: 'result' }>> = {}): ChatEvent => ({
  kind: 'result',
  id: 'r1',
  isError: false,
  text: 'Pronto.',
  durationMs: 1,
  ...over
})
const error = (over: Partial<Extract<ChatEvent, { kind: 'error' }>> = {}): ChatEvent => ({
  kind: 'error',
  id: 'e1',
  text: 'Agent stopped: boom',
  ...over
})

describe('HandoffTracker — envio e execução', () => {
  it('na_fila → enviado pelo hash do texto CRU do agent:send; turn-start → em_execucao', async () => {
    const h = await harness()
    await h.register([
      { conteudo: 'Prompt 1\n', etapas: ['a', 'b'] },
      { conteudo: 'Prompt 2', etapas: ['c'] }
    ])
    const sentAt = h.now() + 1_000
    h.advance(1_000)
    // CRLF e espaço nas pontas: o mesmo hash do conteúdo registrado.
    h.tracker.noteUserSend(CONV, '  Prompt 1\r\n')
    await h.settle()
    let [first, second] = await h.envios()
    expect(first).toMatchObject({ status: 'enviado', enviadoEm: iso(sentAt), iniciadoEm: null })
    expect(second.status).toBe('na_fila')

    h.advance(500)
    h.emit(turnStart)
    await h.settle()
    ;[first, second] = await h.envios()
    expect(first).toMatchObject({ status: 'em_execucao', iniciadoEm: iso(sentAt + 500) })
    expect(second.status).toBe('na_fila')
    // turn-start repetido (o CLI juntou mensagens ao turno) não mexe no início.
    h.advance(500)
    h.emit(turnStart)
    await h.settle()
    expect((await h.envios())[0].iniciadoEm).toBe(iso(sentAt + 500))
    expect(h.changed).toContain(CONV)
  })

  it('texto que não é prompt registrado não mexe em nada', async () => {
    const h = await harness()
    await h.register([{ conteudo: 'Prompt 1', etapas: [] }])
    h.tracker.noteUserSend(CONV, 'continue, por favor')
    await h.settle()
    expect((await h.envios())[0].status).toBe('na_fila')
  })

  it('conversa que não é de handoff: nenhuma entrada lê ou grava nada', async () => {
    const h = await harness()
    const list = vi.spyOn(h.repo, 'listHandoffEnvios')
    const changedBefore = h.changed.length
    h.tracker.noteUserSend('conversa-comum', 'Prompt 1')
    h.tracker.notePermission('conversa-comum', 'p1', true, 'Bash')
    h.tracker.notePermission('conversa-comum', 'p1', false)
    h.tracker.noteBypass('conversa-comum', true)
    h.tracker.sessionEnded('conversa-comum')
    await h.tracker.settled()
    expect(list).not.toHaveBeenCalled()
    expect(h.changed.length).toBe(changedBefore)
    expect(h.tracker.isTurnRunning('conversa-comum')).toBe(false)
  })

  it('pergunta/permissão pendente → aguardando_voce e volta a em_execucao ao fechar a última', async () => {
    const h = await harness()
    await h.register([{ conteudo: 'Prompt 1', etapas: ['a'] }])
    h.tracker.noteUserSend(CONV, 'Prompt 1')
    h.emit(turnStart)
    h.tracker.notePermission(CONV, 'perg-1', true, 'AskUserQuestion')
    h.tracker.notePermission(CONV, 'perm-2', true, 'Bash')
    await h.settle()
    expect((await h.envios())[0].status).toBe('aguardando_voce')

    h.tracker.notePermission(CONV, 'perm-2', false)
    await h.settle()
    expect((await h.envios())[0].status).toBe('aguardando_voce')
    // "Permitir tudo" aprova as permissões em silêncio, mas a pergunta continua aberta.
    h.tracker.noteBypass(CONV, true)
    await h.settle()
    expect((await h.envios())[0].status).toBe('aguardando_voce')
    h.tracker.notePermission(CONV, 'perg-1', false)
    await h.settle()
    expect((await h.envios())[0].status).toBe('em_execucao')

    // Permitir tudo com só permissões abertas: volta a rodar.
    h.tracker.notePermission(CONV, 'perm-3', true, 'Bash')
    await h.settle()
    expect((await h.envios())[0].status).toBe('aguardando_voce')
    h.tracker.noteBypass(CONV, true)
    await h.settle()
    expect((await h.envios())[0].status).toBe('em_execucao')
  })

  it('o fim do turno zera as pendências (resoluções silenciosas não passam por notePermission)', async () => {
    const h = await harness()
    await h.register([{ conteudo: 'Prompt 1', etapas: [] }])
    h.tracker.noteUserSend(CONV, 'Prompt 1')
    h.emit(turnStart)
    h.tracker.notePermission(CONV, 'perm-1', true, 'Bash')
    h.emit(error({ incomplete: true, retryable: true }))
    await h.settle()
    // Retomável: o status fica — mas não espera mais ninguém.
    expect((await h.envios())[0].status).toBe('em_execucao')
    h.emit(turnStart)
    await h.settle()
    expect((await h.envios())[0].status).toBe('em_execucao')
  })
})

describe('HandoffTracker — fim do turno e critério de concluída', () => {
  async function running(etapas: string[]) {
    const h = await harness()
    await h.register([{ conteudo: 'Prompt 1', etapas }])
    h.tracker.noteUserSend(CONV, 'Prompt 1')
    h.emit(turnStart)
    await h.settle()
    return h
  }

  it('result com etapa pendente → incompleta dizendo qual e por quê; subitem sem prefixo não conta', async () => {
    const h = await running(['a', 'b', 'c'])
    h.tasks([
      ['[a] Fazer A', 'completed'],
      ['Rodar os testes', 'completed'],
      ['[b] Fazer B', 'pending']
    ])
    await h.settle()
    h.emit(result())
    await h.settle()
    const [envio] = await h.envios()
    const [a, b, c] = envio.entregas
    expect(envio.status).toBe('incompleta')
    expect(envio.concluidoEm).toBeNull()
    expect(envio.motivo).toBe(
      'faltou 2 de 3 entregas: [b] Etapa b — cartão a fazer; [c] Etapa c — sem cartão no Quadro com o prefixo [c]'
    )
    expect(a).toMatchObject({ status: 'concluida', auditada: true, boardItemId: expect.any(String) })
    expect(b).toMatchObject({ status: 'incompleta', motivo: 'cartão a fazer' })
    expect(c).toMatchObject({ status: 'incompleta', motivo: 'sem cartão no Quadro com o prefixo [c]', boardItemId: null })
  })

  it('todas concluídas e o PO de acordo → concluida; tempo corrido do início ao fim no Quadro', async () => {
    const h = await running(['a', 'b'])
    const start = h.now()
    h.tasks([
      ['[a] Fazer A', 'in_progress'],
      ['[b] Fazer B', 'pending']
    ])
    await h.settle()
    expect((await h.envios())[0].entregas[0]).toMatchObject({ status: 'em_andamento', iniciadaEm: iso(start) })
    h.advance(90_000)
    h.tasks([
      ['[a] Fazer A', 'completed'],
      ['[b] Fazer B', 'completed']
    ])
    await h.settle()
    // O PO confirma (concluído sobre concluído não é contestação).
    await h.board.applyPo({ id: (await h.cardOf('[b]')).id, poStatus: 'completed', poReason: 'conferido', actor: 'po' })
    h.advance(1_000)
    h.emit(result())
    await h.settle()
    const [envio] = await h.envios()
    expect(envio).toMatchObject({ status: 'concluida', concluidoEm: iso(start + 91_000), motivo: null })
    expect(envio.entregas[0]).toMatchObject({ status: 'concluida', concluidaEm: iso(start + 90_000), tempoCorridoMs: 90_000 })
    expect(envio.entregas[1]).toMatchObject({ status: 'concluida', tempoCorridoMs: 0, auditada: true })
  })

  it('PO desligado: concluída sem auditoria', async () => {
    const h = await running(['a'])
    h.po.enabled = false
    h.tasks([['[a] Fazer A', 'completed']])
    h.emit(result())
    await h.settle()
    const [envio] = await h.envios()
    expect(envio.status).toBe('concluida')
    expect(envio.entregas[0].auditada).toBe(false)
  })

  it('o PO contestou → a entrega volta a pendente e o envio fica incompleto com o motivo dele', async () => {
    const h = await running(['a'])
    h.tasks([['[a] Fazer A', 'completed']])
    await h.settle()
    expect((await h.envios())[0].entregas[0].status).toBe('concluida')
    await h.board.applyPo({ id: (await h.cardOf('[a]')).id, poStatus: 'pending', poReason: 'faltou o teste', actor: 'po' })
    await h.settle()
    expect((await h.envios())[0].entregas[0]).toMatchObject({ status: 'pendente', motivo: 'o PO contestou: faltou o teste', concluidaEm: null })
    h.emit(result())
    await h.settle()
    const [envio] = await h.envios()
    expect(envio.status).toBe('incompleta')
    expect(envio.motivo).toBe('faltou 1 de 1 entrega: [a] Etapa a — o PO contestou: faltou o teste')
  })

  it('"fazendo" que o fim de turno devolve para "a fazer" não é contestação do PO', async () => {
    const h = await running(['a'])
    h.tasks([['[a] Fazer A', 'in_progress']])
    await h.settle()
    h.emit(result())
    await h.settle()
    const [envio] = await h.envios()
    expect(envio.status).toBe('incompleta')
    expect(envio.entregas[0]).toMatchObject({ status: 'incompleta', motivo: `cartão a fazer (${BOARD_TURN_END_REASON.result})` })
    expect(envio.motivo).not.toMatch(/contestou/)
  })

  it('veredito do PO depois do fim do turno conclui a última entrega: o envio passa a concluído', async () => {
    const h = await running(['a'])
    h.tasks([['[a] Fazer A', 'in_progress']])
    h.emit(result())
    await h.settle()
    expect((await h.envios())[0].status).toBe('incompleta')
    h.advance(40_000)
    await h.board.applyPo({ id: (await h.cardOf('[a]')).id, poStatus: 'completed', poReason: 'está pronto', actor: 'po' })
    await h.settle()
    const [envio] = await h.envios()
    expect(envio).toMatchObject({ status: 'concluida', motivo: null, concluidoEm: iso(h.now()) })
    expect(envio.entregas[0]).toMatchObject({ status: 'concluida', motivo: null })
  })

  it('turno que terminou com erro também vira concluído com o veredito tardio do PO (o Quadro é a verdade)', async () => {
    const h = await running(['a'])
    h.tasks([['[a] Fazer A', 'in_progress']])
    h.emit(result({ isError: true, text: 'error_during_execution' }))
    await h.settle()
    expect((await h.envios())[0]).toMatchObject({ status: 'incompleta', motivo: expect.stringMatching(/^o turno terminou com erro: error_during_execution/) })
    h.advance(40_000)
    await h.board.applyPo({ id: (await h.cardOf('[a]')).id, poStatus: 'completed', poReason: 'está pronto', actor: 'po' })
    await h.settle()
    const [envio] = await h.envios()
    expect(envio.entregas[0].status).toBe('concluida')
    expect(envio).toMatchObject({ status: 'concluida', concluidoEm: iso(h.now()), motivo: null })
  })

  it('turno com erro, mas com todas as etapas prontas no Quadro: concluída já no fim do turno', async () => {
    const h = await running(['a'])
    h.tasks([['[a] Fazer A', 'completed']])
    h.emit(result({ isError: true, text: 'error_during_execution' }))
    await h.settle()
    expect((await h.envios())[0]).toMatchObject({ status: 'concluida', motivo: null })
  })

  it('arrastar o cartão concluído de volta no Quadro não é contestação do PO', async () => {
    const h = await running(['a'])
    h.tasks([['[a] Fazer A', 'completed']])
    await h.settle()
    await expect(h.board.move((await h.cardOf('[a]')).id, 'pending')).resolves.toEqual({ ok: true })
    h.emit(result())
    await h.settle()
    const motivo = (await h.envios())[0].motivo ?? ''
    expect(motivo).toMatch(/cartão a fazer \(o usuário moveu o cartão para "a fazer" pelo quadro\)/)
    expect(motivo).not.toMatch(/contestou/)
  })

  it('result com erro (Stop) nunca conclui: incompleta com o erro', async () => {
    const h = await running([])
    h.emit(result({ isError: true, text: 'error_during_execution' }))
    await h.settle()
    expect((await h.envios())[0]).toMatchObject({ status: 'incompleta', motivo: 'o turno terminou com erro: error_during_execution' })
  })

  it('erro incomplete+retryable não é falha; a retomada volta a em_execucao', async () => {
    const h = await running(['a'])
    h.emit(error({ incomplete: true, retryable: true, text: 'A sessão do agente encerrou no meio do turno' }))
    await h.settle()
    expect((await h.envios())[0]).toMatchObject({ status: 'em_execucao', motivo: null })
    h.tracker.noteUserSend(CONV, 'Continue de onde parou.')
    h.emit(turnStart)
    await h.settle()
    expect((await h.envios())[0].status).toBe('em_execucao')
  })

  it.each([
    ['sem flags', {}],
    ['incomplete sem retryable', { incomplete: true }],
    ['retryable: false', { incomplete: true, retryable: false }],
    ['cota esgotada sem destino', { incomplete: true, usageExhausted: true }]
  ])('outro erro (%s) → falhou com o texto do erro', async (_caso, flags) => {
    const h = await running(['a'])
    h.emit(error({ ...flags, text: `Agent stopped: ${'x'.repeat(700)}` }))
    await h.settle()
    const [envio] = await h.envios()
    expect(envio.status).toBe('falhou')
    expect(envio.motivo).toHaveLength(500)
    expect(envio.motivo?.startsWith('Agent stopped: x')).toBe(true)
  })

  it('falhou/incompleta voltam a rodar com o próximo turno; concluída não reabre', async () => {
    const h = await running([])
    h.emit(error())
    await h.settle()
    expect((await h.envios())[0].status).toBe('falhou')
    h.tracker.noteUserSend(CONV, 'tente de novo')
    h.emit(turnStart)
    await h.settle()
    expect((await h.envios())[0]).toMatchObject({ status: 'em_execucao', motivo: null })
    h.emit(result())
    await h.settle()
    expect((await h.envios())[0].status).toBe('concluida')
    h.tracker.noteUserSend(CONV, 'ajuste o texto do botão')
    h.emit(turnStart)
    h.emit(error())
    await h.settle()
    expect((await h.envios())[0].status).toBe('concluida')
  })

  it('o 2º prompt vira o envio corrente quando sai; o 1º não muda mais com os turnos dele', async () => {
    const h = await harness()
    await h.register([
      { conteudo: 'Prompt 1', etapas: ['a'] },
      { conteudo: 'Prompt 2', etapas: ['b'] }
    ])
    h.tracker.noteUserSend(CONV, 'Prompt 1')
    h.emit(turnStart)
    h.tasks([
      ['[a] A', 'completed'],
      ['[b] B', 'pending']
    ])
    h.emit(result())
    // A fila da tela só manda o 2º prompt quando o turno anterior fechou de fato.
    await h.settle()
    h.advance(1_000)
    h.tracker.noteUserSend(CONV, 'Prompt 2')
    h.emit({ kind: 'turn-start', turnIds: ['u2'] })
    h.tasks([
      ['[a] A', 'completed'],
      ['[b] B', 'in_progress']
    ])
    await h.settle()
    let [first, second] = await h.envios()
    expect(first.status).toBe('concluida')
    expect(second).toMatchObject({ status: 'em_execucao', enviadoEm: iso(h.now()) })
    expect(second.entregas[0].status).toBe('em_andamento')
    h.tasks([
      ['[a] A', 'completed'],
      ['[b] B', 'completed']
    ])
    h.emit(result())
    await h.settle()
    ;[first, second] = await h.envios()
    expect([first.status, second.status]).toEqual(['concluida', 'concluida'])
  })
})

describe('HandoffTracker — registro depois do 1º envio', () => {
  it('hash visto antes do registro: enviado na hora do agentSend e, com turno rodando, já em execução', async () => {
    const h = await harness()
    const sentAt = h.now()
    h.tracker.noteUserSend(CONV, 'Prompt 1')
    h.advance(300)
    h.emit(turnStart)
    await h.settle()
    // A passada da varredura grava a fatia — ainda sem envio para recebê-la.
    h.advance(3_000)
    await h.tracker.sweep()
    h.advance(2_000)
    await h.register([
      { conteudo: 'Prompt 1', etapas: ['a'] },
      { conteudo: 'Prompt 2', etapas: ['b'] }
    ])
    await h.settle()
    let [first, second] = await h.envios()
    expect(first).toMatchObject({ status: 'em_execucao', enviadoEm: iso(sentAt), iniciadoEm: iso(sentAt + 300) })
    // O tempo do turno antes do registro não se perde: espera o envio existir.
    expect(first.tempoAtivoMs).toBe(3_000)
    expect(second.status).toBe('na_fila')
    h.emit(result())
    await h.settle()
    ;[first, second] = await h.envios()
    expect(first.tempoAtivoMs).toBe(5_000)
    expect(second.tempoAtivoMs).toBe(0)
  })

  it('registro tardio sem turno rodando: só enviado; texto visto não casa duas vezes', async () => {
    const h = await harness()
    const sentAt = h.now()
    h.tracker.noteUserSend(CONV, 'Prompt 1')
    await h.settle()
    h.advance(2_000)
    await h.register([{ conteudo: 'Prompt 1', etapas: [] }])
    await h.settle()
    expect((await h.envios())[0]).toMatchObject({ status: 'enviado', enviadoEm: iso(sentAt), iniciadoEm: null })
    // Um relançamento com o mesmo texto (lote novo) não herda o envio antigo.
    await h.register([{ conteudo: 'Prompt 1', etapas: [] }])
    await h.settle()
    const all = await h.repo.listHandoffEnvios({ conversationId: CONV })
    expect(all.filter((e) => e.status === 'na_fila')).toHaveLength(1)
  })
})
