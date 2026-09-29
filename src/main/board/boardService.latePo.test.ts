// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOARD_TURN_END_REASON, type ChatEvent, type TaskItem } from '../../shared/ipc'
import type { BoardItem, BoardPoWrite, PersistenceRepository } from '../persistence/types'
import { BoardService, RESUME_REASON } from './boardService'

/**
 * O veredito do PO que chega DEPOIS do teto de espera do fechamento.
 *
 * Na conversa "Cadastro no sistema" o PO levou 54 s e 46 s para responder; o
 * fechamento espera no máximo 30 s (`PO_WAIT_MS`) e, passado o teto, devolve
 * para "a fazer" o que ficou "fazendo". O contrato: o teto CONTINUA 30 s, e o
 * CONCLUIR que chega depois vale — grava por cima do "a fazer" do fim de
 * turno, e nada que venha depois (a promoção da mensagem seguinte, o
 * fechamento do turno retomado) o desfaz.
 */

// Pasta REAL: `projectId` resolve a identidade do projeto (ver boardService.test.ts).
const CWD = process.cwd()
const CONV = 'conv-1'
const PO_WAIT_MS = 30_000
const PO_ANSWER_MS = 50_000
const LATE_REASON = 'a resposta final mostra o EXE gerado'
const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 }

function card(patch: Partial<BoardItem> = {}): BoardItem {
  return {
    id: 'bi-1',
    projectId: 'p1',
    projectCwd: CWD,
    conversationId: CONV,
    origin: 'agent',
    sourceId: '1',
    sourceTitle: 'Gerar o EXE do instalador',
    sourceStatus: 'in_progress',
    activeForm: null,
    seq: 0,
    poTitle: null,
    poNote: null,
    poStatus: null,
    poReason: null,
    poAt: null,
    dismissedAt: null,
    revision: 1,
    createdAt: '2026-09-29T12:00:00.000Z',
    updatedAt: '2026-09-29T12:00:00.000Z',
    ...patch
  }
}

function taskList(items: TaskItem[]): ChatEvent {
  return { kind: 'task-list', items }
}

/** Repositório que REFLETE as escritas, com a mesma semântica do `applyBoardPo`
 *  dos dois bancos: sem checagem de revisão nem de estado — campo omitido
 *  fica, campo dado sobrescreve, e `poAt` é o relógio de agora (o falso). */
function liveRepo(initial: BoardItem[], afterList?: (query: { conversationId?: string }) => void) {
  const cards = new Map(initial.map((item) => [item.id, { ...item }]))
  const writes: BoardPoWrite[] = []
  const repo = {
    syncBoardItems: vi.fn(async () => []),
    listBoardItems: vi.fn(async (query: { conversationId?: string; includeDismissed?: boolean }) => {
      const items = [...cards.values()]
        .filter((item) => !query.conversationId || item.conversationId === query.conversationId)
        .filter((item) => query.includeDismissed || item.dismissedAt === null)
        .map((item) => ({ ...item }))
      afterList?.(query)
      return items
    }),
    applyBoardPo: vi.fn(async (input: BoardPoWrite) => {
      writes.push(input)
      const current = cards.get(input.id)
      if (!current) throw new Error('sumiu')
      const next: BoardItem = {
        ...current,
        poTitle: input.poTitle === undefined ? current.poTitle : input.poTitle,
        poStatus: input.poStatus === undefined ? current.poStatus : input.poStatus,
        poReason: input.poReason === undefined ? current.poReason : input.poReason,
        poAt: new Date().toISOString()
      }
      cards.set(input.id, next)
      return { ...next }
    })
  } as unknown as PersistenceRepository
  return { repo, cards, writes }
}

/**
 * O PO lento: a análise em voo do fechamento só termina aos 50 s, e é nesse
 * instante que o CONCLUIR é gravado — como `po.settled`, que só resolve depois
 * das escritas. Fechamentos seguintes recebem a mesma promessa (já resolvida):
 * não há outra análise em voo.
 */
function slowPo(id: string) {
  let board: BoardService | null = null
  let verdict: Promise<void> | null = null
  return {
    bind(service: BoardService): void {
      board = service
    },
    poSettled: (): Promise<void> => {
      verdict ??= new Promise<void>((resolve) => {
        setTimeout(() => {
          void board!
            .applyPo({ id, poStatus: 'completed', poReason: LATE_REASON })
            .catch(() => undefined)
            .then(() => resolve())
        }, PO_ANSWER_MS)
      })
      return verdict
    },
    verdict: (): Promise<void> => verdict ?? Promise.resolve()
  }
}

/** Monta o quadro com o PO lento e SEM `poWaitMs` — o teto é o padrão de
 *  produção. A identidade do projeto (git, E/S de verdade) é resolvida antes
 *  de o relógio virar falso; dali em diante tudo é microtarefa e temporizador. */
async function world(initial: BoardItem[], lateId: string) {
  const { repo, cards, writes } = liveRepo(initial)
  const po = slowPo(lateId)
  const service = new BoardService({ repository: () => repo, poSettled: po.poSettled })
  po.bind(service)
  expect(await service.projectId(CWD)).toBeTruthy()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  return { service, po, cards, writes }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('BoardService — veredito do PO que chega depois do teto de espera', () => {
  it('aos 30 s rebaixa; o CONCLUIR dos 50 s conclui por cima; a mensagem seguinte não o reabre', async () => {
    const { service, po, cards, writes } = await world([card({ id: 'bi-exe' })], 'bi-exe')

    service.observe(CONV, CWD, taskList([{ id: '1', content: 'Gerar o EXE do instalador', status: 'in_progress', activeForm: '' }]))
    service.observe(CONV, CWD, result)

    // O teto padrão continua 30 s: um instante antes, nada foi rebaixado.
    await vi.advanceTimersByTimeAsync(PO_WAIT_MS - 1)
    expect(cards.get('bi-exe')?.poStatus).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    await service.turnClosed(CONV)
    expect(cards.get('bi-exe')).toMatchObject({ poStatus: 'pending', poReason: BOARD_TURN_END_REASON.result })

    // Aos 50 s o PO responde: o "concluído" grava por cima do "a fazer".
    await vi.advanceTimersByTimeAsync(PO_ANSWER_MS - PO_WAIT_MS)
    await po.verdict()
    expect(cards.get('bi-exe')).toMatchObject({ poStatus: 'completed', poReason: LATE_REASON })

    // O usuário responde depois: a promoção só pega o que CONTINUA rebaixado.
    await service.resumeTurn(CONV, CWD)
    expect(cards.get('bi-exe')).toMatchObject({ poStatus: 'completed', poReason: LATE_REASON })
    expect(writes.map((write) => write.poStatus)).toEqual(['pending', 'completed'])
  })

  it('o usuário responde aos 40 s (promovido); o CONCLUIR dos 50 s ainda prevalece, e o fim do turno retomado não o rebaixa', async () => {
    const { service, po, cards, writes } = await world([card({ id: 'bi-exe' })], 'bi-exe')

    service.observe(CONV, CWD, result)
    await vi.advanceTimersByTimeAsync(PO_WAIT_MS)
    await service.turnClosed(CONV)
    expect(cards.get('bi-exe')?.poStatus).toBe('pending')

    await vi.advanceTimersByTimeAsync(10_000) // 40 s: "pode fazer"
    await service.resumeTurn(CONV, CWD)
    expect(cards.get('bi-exe')).toMatchObject({ poStatus: 'in_progress', poReason: RESUME_REASON })

    await vi.advanceTimersByTimeAsync(PO_ANSWER_MS - PO_WAIT_MS - 10_000) // 50 s: o veredito
    await po.verdict()
    expect(cards.get('bi-exe')).toMatchObject({ poStatus: 'completed', poReason: LATE_REASON })

    // O turno retomado termina aos 60 s: o fechamento dele só olha "fazendo".
    await vi.advanceTimersByTimeAsync(10_000)
    service.observe(CONV, CWD, result)
    await service.turnClosed(CONV)
    await service.resumeTurn(CONV, CWD)
    expect(cards.get('bi-exe')).toMatchObject({ poStatus: 'completed', poReason: LATE_REASON })
    expect(writes.map((write) => write.poStatus)).toEqual(['pending', 'in_progress', 'completed'])
  })

  it('o veredito atrasado só toca o cartão que ele julgou: o outro rebaixado continua esperando e é o único promovido', async () => {
    const { service, po, cards } = await world([card({ id: 'bi-exe' }), card({ id: 'bi-login', sourceId: '2', seq: 1 })], 'bi-exe')

    service.observe(CONV, CWD, result)
    await vi.advanceTimersByTimeAsync(PO_ANSWER_MS)
    await service.turnClosed(CONV)
    await po.verdict()
    expect(cards.get('bi-exe')?.poStatus).toBe('completed')
    expect(cards.get('bi-login')).toMatchObject({ poStatus: 'pending', poReason: BOARD_TURN_END_REASON.result })

    await service.resumeTurn(CONV, CWD)
    expect(cards.get('bi-exe')?.poStatus).toBe('completed')
    expect(cards.get('bi-login')).toMatchObject({ poStatus: 'in_progress', poReason: RESUME_REASON })
  })

  it('o CONCLUIR que chega NO MEIO da reabertura (depois da leitura, antes da escrita dela) espera e grava por cima', async () => {
    // A janela entre a releitura da reabertura e a escrita dela: no PostgreSQL
    // são idas e voltas de rede, e o veredito atrasado pode cair bem ali. O
    // gatilho é a própria leitura da reabertura (a única com `conversationId`).
    let service!: BoardService
    let late: Promise<unknown> | null = null
    const { repo, cards, writes } = liveRepo([card({ id: 'bi-exe' })], (query) => {
      if (query.conversationId && !late) {
        late = service.applyPo({ id: 'bi-exe', poStatus: 'completed', poReason: LATE_REASON })
      }
    })
    service = new BoardService({
      repository: () => repo,
      poSettled: () => new Promise<void>(() => undefined), // o PO ainda está pensando
      poWaitMs: 1
    })

    service.observe(CONV, CWD, result)
    await service.turnClosed(CONV)
    await late

    expect(cards.get('bi-exe')).toMatchObject({ poStatus: 'completed', poReason: LATE_REASON })
    expect(writes.map((write) => write.poStatus)).toEqual(['pending', 'completed'])
  })
})
