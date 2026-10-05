// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatEvent } from '../../shared/ipc'
import type { HandoffRepository } from '../persistence/types'
import { HANDOFF_STALL_MS } from './handoffRules'
import { iso } from './handoffTestKit'
import { HandoffTracker, type HandoffBoard } from './handoffTracker'
import { CONV, closeHarnesses, harness } from './handoffTrackerHarness'

// Tempo (ativo, corrido, retrabalho) com o relógio injetado, a parada da
// varredura e a garantia de que o tracker nunca lança.

afterEach(closeHarnesses)

const turnStart: ChatEvent = { kind: 'turn-start', turnIds: ['u1'] }
const result: ChatEvent = { kind: 'result', id: 'r1', isError: false, text: 'Pronto.', durationMs: 1 }
const SEC = 1_000
const MIN = 60_000

async function running(etapas: string[]) {
  const h = await harness()
  await h.register([{ conteudo: 'Prompt 1', etapas }])
  h.tracker.noteUserSend(CONV, 'Prompt 1')
  h.emit(turnStart)
  await h.settle()
  return h
}

describe('HandoffTracker — tempo', () => {
  it('ativo não conta pergunta pendente; corrido conta o relógio do início ao fim no Quadro', async () => {
    const h = await running(['a'])
    h.tasks([['[a] Fazer A', 'in_progress']])
    await h.settle()
    h.advance(30 * SEC)
    h.tracker.notePermission(CONV, 'perg-1', true, 'AskUserQuestion')
    await h.settle()
    h.advance(60 * SEC) // esperando você: não conta
    h.tracker.notePermission(CONV, 'perg-1', false)
    await h.settle()
    h.advance(10 * SEC)
    h.tasks([['[a] Fazer A', 'completed']])
    await h.settle()
    h.advance(5 * SEC)
    h.emit(result)
    await h.settle()
    const [envio] = await h.envios()
    expect(envio.status).toBe('concluida')
    expect(envio.tempoAtivoMs).toBe(45 * SEC)
    // A entrega só conta enquanto está em andamento (os 5 s finais, já concluída, não).
    expect(envio.entregas[0]).toMatchObject({ tempoAtivoMs: 40 * SEC, tempoCorridoMs: 100 * SEC, retrabalhoMs: 0 })
  })

  it('sem turno rodando (app fechado, conversa parada) o tempo não anda', async () => {
    const h = await running(['a'])
    h.advance(20 * SEC)
    h.emit(result)
    await h.settle()
    expect((await h.envios())[0]).toMatchObject({ status: 'incompleta', tempoAtivoMs: 20 * SEC })
    h.advance(60 * MIN)
    await h.tracker.sweep()
    h.emit(turnStart)
    await h.settle()
    expect((await h.envios())[0]).toMatchObject({ status: 'em_execucao', tempoAtivoMs: 20 * SEC })
    h.advance(10 * SEC)
    h.emit(result)
    await h.settle()
    expect((await h.envios())[0].tempoAtivoMs).toBe(30 * SEC)
  })

  it('a varredura grava a fatia de quem está rodando a cada passada', async () => {
    const h = await running([])
    h.advance(60 * SEC)
    await expect(h.tracker.sweep()).resolves.toEqual({ flushed: 1, stalled: 0 })
    expect((await h.envios())[0]).toMatchObject({ status: 'em_execucao', tempoAtivoMs: 60 * SEC })
    expect(h.tracker.unflushedActiveMs(CONV)).toBe(0)
    h.advance(30 * SEC)
    expect(h.tracker.unflushedActiveMs(CONV)).toBe(30 * SEC)
    h.emit(result)
    await h.settle()
    expect((await h.envios())[0].tempoAtivoMs).toBe(90 * SEC)
  })

  it('sessão descartada ou substituída no meio do turno: o tempo ativo para de contar', async () => {
    const h = await running([])
    h.advance(20 * SEC)
    // Troca de sessão (outro modelo/config): dispose sem `result`/`error`.
    h.tracker.sessionEnded(CONV)
    await h.settle()
    expect(h.tracker.isTurnRunning(CONV)).toBe(false)
    expect(h.tracker.unflushedActiveMs(CONV)).toBe(0)
    expect((await h.envios())[0]).toMatchObject({ status: 'em_execucao', tempoAtivoMs: 20 * SEC })
    h.advance(60 * SEC)
    await expect(h.tracker.sweep()).resolves.toEqual({ flushed: 0, stalled: 0 })
    expect((await h.envios())[0].tempoAtivoMs).toBe(20 * SEC)
    // Sem turno, a parada volta a valer.
    h.advance(HANDOFF_STALL_MS)
    await expect(h.tracker.sweep()).resolves.toEqual({ flushed: 0, stalled: 1 })
    expect((await h.envios())[0]).toMatchObject({ status: 'parada', tempoAtivoMs: 20 * SEC })
  })

  it('depois de concluído, mensagem nova não reabre: o tempo vai para retrabalho', async () => {
    const h = await running(['a'])
    h.tasks([['[a] Fazer A', 'completed']])
    h.advance(10 * SEC)
    h.emit(result)
    await h.settle()
    expect((await h.envios())[0]).toMatchObject({ status: 'concluida', tempoAtivoMs: 10 * SEC })

    h.tracker.noteUserSend(CONV, 'o botão ficou desalinhado, ajuste')
    h.emit({ kind: 'turn-start', turnIds: ['u2'] })
    h.tasks([['[a] Fazer A', 'in_progress']])
    await h.settle()
    h.advance(20 * SEC)
    h.emit(result)
    await h.settle()
    const [envio] = await h.envios()
    expect(envio).toMatchObject({ status: 'concluida', tempoAtivoMs: 10 * SEC, retrabalhoMs: 20 * SEC })
    expect(envio.entregas[0]).toMatchObject({ status: 'concluida', retrabalhoMs: 20 * SEC })
  })
})

describe('HandoffTracker — parada (varredura, 10 min)', () => {
  it('enviado sem nenhum turno: parada exatamente no limite', async () => {
    const h = await harness()
    await h.register([{ conteudo: 'Prompt 1', etapas: [] }])
    h.tracker.noteUserSend(CONV, 'Prompt 1')
    await h.settle()
    h.advance(HANDOFF_STALL_MS - 1)
    await h.tracker.sweep()
    expect((await h.envios())[0].status).toBe('enviado')
    h.advance(1)
    await expect(h.tracker.sweep()).resolves.toMatchObject({ stalled: 1 })
    expect((await h.envios())[0]).toMatchObject({
      status: 'parada',
      motivo: 'o prompt foi enviado, mas nenhum turno começou em 10 min'
    })
    // Parada volta a rodar quando um turno começa.
    h.emit(turnStart)
    await h.settle()
    expect((await h.envios())[0]).toMatchObject({ status: 'em_execucao', motivo: null })
  })

  it('em execução sem turno (erro retomado que não voltou) vira parada; o 2º prompt na fila também', async () => {
    const h = await harness()
    await h.register([
      { conteudo: 'Prompt 1', etapas: [] },
      { conteudo: 'Prompt 2', etapas: [] }
    ])
    h.tracker.noteUserSend(CONV, 'Prompt 1')
    h.emit(turnStart)
    h.emit({ kind: 'error', id: 'e1', text: 'travou', incomplete: true, retryable: true })
    await h.settle()
    h.advance(HANDOFF_STALL_MS)
    await h.tracker.sweep()
    const [first, second] = await h.envios()
    expect(first).toMatchObject({ status: 'parada', motivo: 'nenhum turno rodando há 10 min, sem pergunta pendente e sem conclusão' })
    expect(second).toMatchObject({ status: 'parada', motivo: 'o prompt ficou 10 min na fila sem ser enviado' })
    // O prompt que encalhou na fila ainda casa pelo hash quando finalmente sai.
    h.tracker.noteUserSend(CONV, 'Prompt 2')
    await h.settle()
    expect((await h.envios())[1]).toMatchObject({ status: 'enviado', motivo: null, enviadoEm: expect.any(String) })
  })

  it('turno rodando, pergunta aberta ou esperando você: nunca parada', async () => {
    const h = await running([])
    h.advance(3 * HANDOFF_STALL_MS)
    await h.tracker.sweep()
    expect((await h.envios())[0].status).toBe('em_execucao')
    h.tracker.notePermission(CONV, 'perg-1', true, 'AskUserQuestion')
    await h.settle()
    h.advance(3 * HANDOFF_STALL_MS)
    await h.tracker.sweep()
    expect((await h.envios())[0]).toMatchObject({ status: 'aguardando_voce', tempoAtivoMs: 3 * HANDOFF_STALL_MS })
  })

  it('app reaberto: as conversas com envio em curso no banco viram conhecidas e param depois do limite', async () => {
    const h = await running([])
    await h.tracker.sweep()
    // O app fechou no meio do turno: nenhum result chegou. Outro processo:
    const tracker = h.reopen()
    await expect(tracker.loadKnown()).resolves.toBe(true)
    h.advance(HANDOFF_STALL_MS - SEC)
    await tracker.sweep()
    expect((await h.envios())[0].status).toBe('em_execucao')
    h.advance(SEC)
    await tracker.sweep()
    expect((await h.envios())[0].status).toBe('parada')
  })

  it('app fechado com pergunta aberta: o "esperando você" sem pendência viva para depois do limite', async () => {
    const h = await running([])
    h.tracker.notePermission(CONV, 'perg-1', true, 'AskUserQuestion')
    await h.settle()
    expect((await h.envios())[0].status).toBe('aguardando_voce')
    // O app fechou com a pergunta aberta; reaberto, ninguém mais a responde.
    const tracker = h.reopen()
    await tracker.loadKnown()
    h.advance(HANDOFF_STALL_MS - SEC)
    await tracker.sweep()
    expect((await h.envios())[0].status).toBe('aguardando_voce')
    h.advance(SEC)
    await expect(tracker.sweep()).resolves.toMatchObject({ stalled: 1 })
    expect((await h.envios())[0]).toMatchObject({
      status: 'parada',
      motivo: 'esperava você, mas não há pergunta aberta nem turno rodando há 10 min'
    })
  })

  it('banco compartilhado: o 1º prompt rodando noutro PC segura o 2º na fila — a parada é por conversa', async () => {
    const h = await harness()
    await h.register([
      { conteudo: 'Prompt 1', etapas: [] },
      { conteudo: 'Prompt 2', etapas: [] }
    ])
    await h.settle()
    // O PC A mandou o 1º prompt e grava o tempo dele a cada passada.
    const [first] = await h.envios()
    await h.repo.updateHandoffEnvio(first.id, { status: 'em_execucao', enviadoEm: iso(h.now()), iniciadoEm: iso(h.now()) })
    let otherPcWroteAt = (): number => h.now() - 30 * SEC
    const read = h.repo.listHandoffEnvios.bind(h.repo)
    h.repo.listHandoffEnvios = async (query) =>
      (await read(query)).map((e) => (e.id === first.id ? { ...e, updatedAt: iso(otherPcWroteAt()) } : e))
    // Este é o PC B: nenhum turno da conversa roda aqui.
    const tracker = h.reopen()
    await tracker.loadKnown()
    h.advance(HANDOFF_STALL_MS)
    await expect(tracker.sweep()).resolves.toMatchObject({ stalled: 0 })
    expect((await h.envios()).map((e) => e.status)).toEqual(['em_execucao', 'na_fila'])
    // O PC A parou de gravar: 10 min depois da última escrita, a conversa toda para.
    const stoppedAt = otherPcWroteAt()
    otherPcWroteAt = () => stoppedAt
    h.advance(HANDOFF_STALL_MS - 30 * SEC - 1)
    await expect(tracker.sweep()).resolves.toMatchObject({ stalled: 0 })
    h.advance(1)
    await expect(tracker.sweep()).resolves.toMatchObject({ stalled: 2 })
    expect((await h.envios()).map((e) => e.status)).toEqual(['parada', 'parada'])
  })

  it('conversa sem nada que possa parar não é relida a cada passada', async () => {
    const h = await running([])
    h.emit(result)
    await h.settle()
    h.advance(HANDOFF_STALL_MS)
    const reads: unknown[] = []
    const original = h.repo.listHandoffEnvios.bind(h.repo)
    h.repo.listHandoffEnvios = async (query) => {
      reads.push(query)
      return original(query)
    }
    await h.tracker.sweep()
    await h.tracker.sweep()
    expect(reads).toHaveLength(1)
    expect((await h.envios())[0].status).toBe('concluida')
  })
})

describe('HandoffTracker — nunca lança, nunca derruba a conversa', () => {
  const failingRepo = (): HandoffRepository => {
    const boom = async (): Promise<never> => {
      throw new Error('banco fora do ar')
    }
    return {
      createHandoffEnvios: boom,
      listHandoffEnvios: boom,
      updateHandoffEnvio: boom,
      updateHandoffEntrega: boom,
      addHandoffTime: boom
    }
  }
  const failingBoard: HandoffBoard = {
    list: async () => {
      throw new Error('quadro fora do ar')
    },
    settled: async () => {
      throw new Error('x')
    },
    turnClosed: async () => {
      throw new Error('x')
    }
  }

  it.each([
    ['getter do repositório lança', () => {
      throw new Error('troca de backend')
    }],
    ['repositório rejeita tudo', failingRepo]
  ])('%s: entradas não lançam, a fila esvazia e a varredura resolve', async (_caso, repository) => {
    const logs: string[] = []
    let now = 0
    const tracker = new HandoffTracker({
      repository: repository as () => HandoffRepository | null,
      board: failingBoard,
      poEnabled: () => {
        throw new Error('config ilegível')
      },
      clock: () => now,
      onChanged: () => {
        throw new Error('janela fechada')
      },
      log: (line) => logs.push(line)
    })
    expect(() => {
      tracker.attach(CONV, 'C:/proj')
      tracker.noteUserSend(CONV, 'Prompt 1')
      tracker.observe(CONV, 'C:/proj', turnStart)
      tracker.notePermission(CONV, 'p1', true, 'Bash')
      tracker.observe(CONV, 'C:/proj', { kind: 'task-list', items: [] })
      tracker.boardChanged('proj-1')
      tracker.notePermission(CONV, 'p1', false)
      tracker.observe(CONV, 'C:/proj', result)
      tracker.observe(CONV, 'C:/proj', { kind: 'error', id: 'e', text: 'x' })
      tracker.onRegistered([])
      tracker.sessionEnded(CONV)
    }).not.toThrow()
    await expect(tracker.settled()).resolves.toBeUndefined()
    now += 2 * HANDOFF_STALL_MS
    await expect(tracker.sweep()).resolves.toMatchObject({ flushed: 0 })
    await expect(tracker.currentEnvio(CONV)).resolves.toBeNull()
    await expect(tracker.correctEntrega({ entregaId: 'hn-x', acao: 'concluir' })).rejects.toThrow()
    expect(tracker.isTurnRunning(CONV)).toBe(false)
  })

  it('evento que não interessa (texto, ferramenta) não cria estado nem fila', async () => {
    const h = await harness({ attach: false })
    h.tracker.observe('outra', h.cwd, { kind: 'assistant-text', id: 'x', text: 'oi', final: true })
    h.tracker.observe('outra', h.cwd, { kind: 'tool-input-delta', toolUseId: 't', name: 'Edit', newText: '', totalLines: 0, done: false })
    h.tracker.noteUserSend('outra', 'Prompt 1')
    await h.tracker.settled()
    expect(h.tracker.isTurnRunning('outra')).toBe(false)
    expect(h.changed).toEqual([])
  })
})
