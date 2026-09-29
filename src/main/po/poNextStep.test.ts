// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { boardItemStatus, BOARD_TURN_END_REASON, type BoardConfig, type BoardItem, type ChatEvent } from '../../shared/ipc'
import { BoardService, RESUME_REASON } from '../board/boardService'
import type { BoardPoCreate, BoardPoWrite, PersistenceRepository } from '../persistence/types'
import { Po, type PoObserverRequest } from './po'
import { PO_AWAITING_AUTHORIZATION_REASON } from './poPrompt'

/**
 * O caminho inteiro do "passo novo proposto": o fechamento conclui o cartão do
 * pedido (A) e cria o do passo que o agente perguntou se fazia (B, "a fazer",
 * aguardando autorização); o "pode fazer" seguinte põe B em andamento e deixa A
 * concluído — nem o PO (a barreira descarta ANDAMENTO em cartão que não está
 * "a fazer") nem a promoção determinística do quadro (`resumeTurn`, que só
 * retoma o que o fim do turno rebaixou) mexem em A.
 *
 * Os textos são os da conversa real "Cadastro no sistema".
 */

const CWD = process.cwd()
const CONV = 'conv-1'
const A = 'bi-po-e13d96f9-e46'
const A_TITLE = 'Auditar/remover qualquer registro em Cloudflare ou conta própria feito sem autorização'
const B_TITLE = 'Atualizar a VPS (APP_BASE_URL e .exe novo)'
const PEDIDO =
  'olha as conversas, hermes.larchertech.com eu desativei nao é pra registrar nada no meu cloud flare e e nenhuma conta minha sem eu pedi'
const RESPOSTA =
  'Cloudflare: na última tentativa só abri a janela "Adicionar registro" e não salvei nada; o `hermes` continua ' +
  'desativado. Gerei o `.exe` novo e os testes passaram. Falta, na VPS, e só faço se você autorizar: trocar o ' +
  '`APP_BASE_URL` e enviar o `.exe` novo. Isso se troca na sua conta do Mercado Pago, e eu não vou mexer lá. ' +
  'Posso atualizar a VPS?'
const CLOSE_VERDICT = `CONCLUIR ${A} | auditoria entregue: nada registrado sem autorização\nNOVA | ${B_TITLE} | ${PO_AWAITING_AUTHORIZATION_REASON}`
const openVerdict = (b: string): string => `ANDAMENTO ${b} | o usuário autorizou o passo\nANDAMENTO ${A} | retomando`

function card(over: Partial<BoardItem> = {}): BoardItem {
  return {
    id: A,
    projectId: 'p',
    projectCwd: CWD,
    conversationId: CONV,
    origin: 'po',
    sourceId: null,
    sourceTitle: A_TITLE,
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
    createdAt: '',
    updatedAt: '',
    ...over
  }
}

const config = (): BoardConfig => ({ requirePlan: true, po: { enabled: true, model: 'claude-sonnet-5-5' } })
const reply = (text: string): ChatEvent => ({ kind: 'assistant-text', id: 'a', text, final: true })
const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 }
/** O registro de tarefas fica fora: o que está em jogo aqui é só o quadro. */
const noLedger = { listConvTasks: async () => [], linkableLedgerTasks: async () => [] }

/** Um repositório em memória que REFLETE as escritas — mesmo espírito do
 *  `liveRepo` de boardResume.test.ts, com a criação do PO a mais. */
function memoryRepo(initial: BoardItem[]) {
  const cards = new Map(initial.map((item) => [item.id, { ...item }]))
  const writes: BoardPoWrite[] = []
  let created = 0
  const repo = {
    syncBoardItems: vi.fn(async () => []),
    listBoardItems: vi.fn(async (query: { conversationId?: string; includeDismissed?: boolean }) =>
      [...cards.values()]
        .filter((item) => !query.conversationId || item.conversationId === query.conversationId)
        .filter((item) => query.includeDismissed || item.dismissedAt === null)
        .map((item) => ({ ...item }))
    ),
    applyBoardPo: vi.fn(async (input: BoardPoWrite) => {
      writes.push(input)
      const current = cards.get(input.id)
      if (!current) throw new Error('sumiu')
      const next = {
        ...current,
        poTitle: input.poTitle ?? current.poTitle,
        poStatus: input.poStatus ?? current.poStatus,
        poReason: input.poReason ?? current.poReason,
        poAt: new Date().toISOString()
      }
      cards.set(input.id, next)
      return { ...next }
    }),
    // Como o SQLite: o cartão do PO nasce com o status em `source_status` e o
    // motivo em `po_reason`, sem `po_status`.
    createBoardPoItem: vi.fn(async (input: BoardPoCreate) => {
      const item = card({
        id: `bi-po-novo-${++created}`,
        projectId: input.projectId,
        projectCwd: input.projectCwd,
        conversationId: input.conversationId,
        sourceTitle: input.title,
        sourceStatus: input.status,
        poReason: input.reason,
        seq: cards.size
      })
      cards.set(item.id, item)
      return { ...item }
    })
  } as unknown as PersistenceRepository
  return { repo, cards, writes }
}

/** O dublê do quadro no formato de po.test.ts/poGate.test.ts, escrevendo no
 *  repositório em memória para o status final ser observável. */
function fakeBoard(initial: BoardItem[]) {
  const { repo, cards } = memoryRepo(initial)
  const board = {
    settled: vi.fn(async () => undefined),
    list: vi.fn(async () => repo.listBoardItems({ projectIds: ['p'], conversationId: CONV })),
    projectId: vi.fn(async () => 'p'),
    applyPo: vi.fn((input: BoardPoWrite) => repo.applyBoardPo(input)),
    createPoItem: vi.fn((input: BoardPoCreate) => repo.createBoardPoItem(input))
  } as unknown as BoardService & { applyPo: ReturnType<typeof vi.fn> }
  return { board, cards }
}

describe('Po — "pode fazer" depois do passo proposto (dublê do quadro)', () => {
  it('o fechamento conclui A e cria B "a fazer"; a abertura seguinte põe só B em andamento', async () => {
    const { board, cards } = fakeBoard([card()])
    const prompts: PoObserverRequest[] = []
    const runClaude = vi.fn(async (request: PoObserverRequest) => {
      prompts.push(request)
      const b = [...cards.values()].find((item) => item.sourceTitle === B_TITLE)
      const text = request.phase === 'close' ? CLOSE_VERDICT : b ? openVerdict(b.id) : 'OK'
      return { provider: 'claude' as const, state: 'completed' as const, text }
    })
    let now = 1_000_000
    const po = new Po({ config, board, runClaude, gateActive: async () => false, now: () => now, ...noLedger })

    po.noteUserMessage(CONV, CWD, PEDIDO)
    po.observe(CONV, reply(RESPOSTA))
    po.observe(CONV, result)
    await po.settled(CONV)

    const b = [...cards.values()].find((item) => item.sourceTitle === B_TITLE)!
    expect(boardItemStatus(cards.get(A)!)).toBe('completed')
    expect(b).toMatchObject({ sourceStatus: 'pending', poStatus: null, poReason: PO_AWAITING_AUTHORIZATION_REASON })

    now += 61_000
    po.noteUserMessage(CONV, CWD, 'pode fazer')
    await po.settled(CONV)

    // O modelo viu a pergunta que o usuário está respondendo e o cartão do passo.
    const open = prompts.at(-1)!
    expect(open.phase).toBe('open')
    expect(open.prompt).toContain('Posso atualizar a VPS?')
    expect(open.prompt).toContain(`${b.id} [a fazer] ${B_TITLE}`)
    expect(open.prompt).toContain(`${A} [concluída]`)
    // Só B entrou em andamento; o ANDAMENTO em A morreu na barreira.
    expect(boardItemStatus(cards.get(b.id)!)).toBe('in_progress')
    expect(cards.get(b.id)!.poReason).toBe('o usuário autorizou o passo')
    expect(boardItemStatus(cards.get(A)!)).toBe('completed')
    expect(board.applyPo).not.toHaveBeenCalledWith(expect.objectContaining({ id: A, poStatus: 'in_progress' }))
  })
})

/** Quadro e PO ligados na mesma ordem do tee do index.ts (ver
 *  boardResume.sqlite.test.ts), com o repositório em memória acima. */
function world(openAnswer: (bId: string | undefined) => string) {
  const { repo, cards, writes } = memoryRepo([card()])
  const board = new BoardService({ repository: () => repo, poSettled: (id) => po.settled(id), poWaitMs: 2_000 })
  let clock = 1_000_000
  const bId = (): string | undefined => [...cards.values()].find((item) => item.sourceTitle === B_TITLE)?.id
  const po: Po = new Po({
    config,
    board,
    now: () => clock,
    ask: async (prompt) => (prompt.includes('AÇÕES DESTE TURNO') ? CLOSE_VERDICT : openAnswer(bId())),
    gateActive: async () => false,
    scheduleFlush: () => () => undefined,
    ...noLedger
  })
  const emit = (event: ChatEvent): void => {
    board.observe(CONV, CWD, event)
    po.observe(CONV, event)
  }
  const userSays = async (text: string): Promise<void> => {
    clock += 61_000
    po.noteUserMessage(CONV, CWD, text)
    await board.resumeTurn(CONV, CWD)
    await po.settled(CONV)
  }
  const idle = async (): Promise<void> => {
    await board.settled(CONV)
    await po.settled(CONV)
    await board.turnClosed(CONV)
  }
  return { emit, userSays, idle, cards, writes, bId }
}

describe('BoardService real — o fechamento que não rebaixou nada não deixa o resumeTurn mexer em A nem B', () => {
  it('"pode fazer" com a abertura do PO respondendo OK: A continua concluída e B continua "a fazer"', async () => {
    const w = world(() => 'OK')
    await w.userSays(PEDIDO)
    w.emit(reply(RESPOSTA))
    w.emit(result)
    await w.idle()

    const b = w.bId()!
    expect(boardItemStatus(w.cards.get(A)!)).toBe('completed')
    expect(boardItemStatus(w.cards.get(b)!)).toBe('pending')
    // O fim do turno não rebaixou nada: A foi concluída pelo PO antes da
    // reabertura, e B nasceu "a fazer".
    expect(w.writes.some((write) => write.poReason === BOARD_TURN_END_REASON.result)).toBe(false)

    const before = w.writes.length
    await w.userSays('pode fazer')
    expect(w.writes.slice(before)).toEqual([])
    expect(boardItemStatus(w.cards.get(A)!)).toBe('completed')
    expect(w.cards.get(b)).toMatchObject({ sourceStatus: 'pending', poReason: PO_AWAITING_AUTHORIZATION_REASON })
    expect(w.writes.some((write) => write.poReason === RESUME_REASON)).toBe(false)
  })

  it('"pode fazer" com o PO pedindo ANDAMENTO em B e em A: só B anda, e o resumeTurn não soma escrita nenhuma', async () => {
    const w = world((b) => (b ? openVerdict(b) : 'OK'))
    await w.userSays(PEDIDO)
    w.emit(reply(RESPOSTA))
    w.emit(result)
    await w.idle()

    const b = w.bId()!
    const before = w.writes.length
    await w.userSays('pode fazer')

    expect(w.writes.slice(before)).toEqual([{ id: b, poStatus: 'in_progress', poReason: 'o usuário autorizou o passo' }])
    expect(boardItemStatus(w.cards.get(b)!)).toBe('in_progress')
    expect(boardItemStatus(w.cards.get(A)!)).toBe('completed')
  })
})
