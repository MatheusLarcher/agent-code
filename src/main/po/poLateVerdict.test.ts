// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BOARD_TURN_END_REASON,
  boardItemAwaitingBadge,
  boardItemStatus,
  type BoardConfig,
  type BoardItem,
  type ChatEvent
} from '../../shared/ipc'
import { BoardService } from '../board/boardService'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { Po } from './po'

/**
 * O veredito atrasado de ponta a ponta: Po real + BoardService real + SQLite
 * real, ligados na mesma ordem do tee do index.ts (quadro primeiro, PO depois),
 * com o teto de espera PADRÃO (30 s) e um modelo que só responde aos 50 s — o
 * caso da conversa "Cadastro no sistema". O fechamento rebaixa no meio da
 * consulta; o que o PO decide depois vale e nada o desfaz.
 */

const CWD = process.cwd()
const CONV = 'conv-late'
const PO_WAIT_MS = 30_000
const PO_ANSWER_MS = 50_000
const EXE = 'Gerar o EXE do instalador'
const LOGIN = 'Revisar o login Google'
const tempDirs: string[] = []
const repositories: SqliteRepository[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(repositories.splice(0).map((repository) => repository.close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

type Status = 'pending' | 'in_progress' | 'completed'

const taskList = (items: [string, Status][]): ChatEvent => ({
  kind: 'task-list',
  items: items.map(([content, status], index) => ({ id: String(index + 1), content, status, activeForm: '' }))
})
const reply = (text: string): ChatEvent => ({ kind: 'assistant-text', id: 'a', text, final: true })
const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 }

/**
 * `verdict` escreve a resposta do FECHAMENTO a partir do quadro que o modelo
 * viu (lido no início da consulta, antes do rebaixamento); a abertura responde
 * OK na hora. As leituras do quadro pelo serviço ficam em `reads`, com o
 * instante (relógio falso) e o status de cada cartão — é como o teste enxerga
 * a releitura fresca de `confirmCreates`.
 */
async function world(verdict: (byTitle: (title: string) => BoardItem) => string) {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-late-po-'))
  tempDirs.push(cache)
  const repository = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'device-a')
  await repository.initialize()
  repositories.push(repository)
  const config = (): BoardConfig => ({ requirePlan: true, po: { enabled: true, model: 'claude-sonnet-5-5' } })
  // Sem `poWaitMs`: o teto é o de produção. `po` vem logo abaixo; a referência
  // preguiçosa é a mesma do index.ts.
  const board = new BoardService({ repository: () => repository, poSettled: (id): Promise<void> => po.settled(id) })
  const projectId = await board.projectId(CWD)
  const snapshot = async (): Promise<BoardItem[]> =>
    repository.listBoardItems({ projectIds: [projectId], conversationId: CONV })
  const byTitleIn = (items: BoardItem[]) => (title: string): BoardItem => {
    const found = items.find((item) => item.sourceTitle === title)
    if (!found) throw new Error(`cartão ausente: ${title}`)
    return found
  }

  const reads: { at: number; statuses: Record<string, Status> }[] = []
  const list = board.list.bind(board)
  vi.spyOn(board, 'list').mockImplementation(async (cwd, options) => {
    const items = await list(cwd, options)
    reads.push({ at: Date.now(), statuses: Object.fromEntries((items ?? []).map((item) => [item.sourceTitle, boardItemStatus(item)])) })
    return items
  })

  let closing = false
  const po: Po = new Po({
    config,
    board,
    ask: async () => {
      if (!closing) return 'OK'
      const answer = verdict(byTitleIn(await snapshot()))
      return new Promise<string>((resolve) => setTimeout(() => resolve(answer), PO_ANSWER_MS))
    },
    gateActive: async () => false,
    listConvTasks: async () => [],
    scheduleFlush: () => () => undefined
  })
  const emit = (event: ChatEvent): void => {
    board.observe(CONV, CWD, event)
    po.observe(CONV, event)
  }
  const userSays = (text: string): Promise<void> => {
    po.noteUserMessage(CONV, CWD, text)
    return board.resumeTurn(CONV, CWD)
  }
  const idle = async (): Promise<void> => {
    await board.settled(CONV)
    await po.settled(CONV)
    await board.turnClosed(CONV)
  }

  /** O turno de trabalho, com relógio de verdade (a abertura, a ingestão). */
  const workTurn = async (items: [string, Status][]): Promise<void> => {
    await userSays('gera o EXE do instalador')
    emit(taskList(items))
    await idle()
  }

  /** Fecha o turno com o relógio falso: aos 30 s o fechamento já rebaixou, com
   *  o modelo do PO ainda pensando; aos 50 s o veredito foi gravado. */
  const closeTurnWithLatePo = async (): Promise<{ at30: BoardItem[]; startedAt: number }> => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const startedAt = Date.now()
    closing = true
    emit(reply('EXE gerado em dist/instalador.exe e publicado no release.'))
    emit(result)
    await vi.advanceTimersByTimeAsync(PO_WAIT_MS)
    await board.turnClosed(CONV)
    const at30 = await snapshot()
    await vi.advanceTimersByTimeAsync(PO_ANSWER_MS - PO_WAIT_MS)
    await po.settled(CONV)
    return { at30, startedAt }
  }

  return { board, emit, userSays, snapshot, byTitleIn, reads, workTurn, closeTurnWithLatePo }
}

describe('Po + BoardService — veredito do fechamento que chega depois do teto de 30 s', () => {
  it('CONCLUIR aos 50 s: o cartão rebaixado aos 30 s termina concluído, e a mensagem seguinte não o reabre', async () => {
    const w = await world((card) => `CONCLUIR ${card(EXE).id} | a resposta final mostra o EXE gerado`)
    await w.workTurn([[EXE, 'in_progress']])

    const { at30 } = await w.closeTurnWithLatePo()
    expect(w.byTitleIn(at30)(EXE)).toMatchObject({ poStatus: 'pending', poReason: BOARD_TURN_END_REASON.result })

    let exe = w.byTitleIn(await w.snapshot())(EXE)
    expect(exe).toMatchObject({ poStatus: 'completed', poReason: 'a resposta final mostra o EXE gerado' })
    expect(boardItemAwaitingBadge(exe)).toBeNull()

    await w.userSays('valeu')
    exe = w.byTitleIn(await w.snapshot())(EXE)
    expect(exe.poStatus).toBe('completed')
  })

  it('CONCLUIR + TITULO + FEITA + NOVA aos 50 s: tudo passa pela lista FRESCA (cartão já "a fazer") e é aplicado', async () => {
    const w = await world((card) =>
      [
        `CONCLUIR ${card(EXE).id} | a resposta final mostra o EXE gerado`,
        `TITULO ${card(EXE).id} | Gerar o instalador EXE`,
        'FEITA | Publicar o EXE no release | a resposta diz que foi publicado',
        'NOVA | Assinar o EXE | o agente disse que assina depois'
      ].join('\n')
    )
    await w.workTurn([[EXE, 'in_progress']])

    const { startedAt } = await w.closeTurnWithLatePo()

    // `confirmCreates` releu o quadro na hora do veredito, com o cartão já
    // rebaixado — e o CONCLUIR passou pela barreira mesmo assim.
    const fresh = w.reads.filter((read) => read.at >= startedAt + PO_ANSWER_MS)
    expect(fresh).toHaveLength(1)
    expect(fresh[0].statuses[EXE]).toBe('pending')

    const items = await w.snapshot()
    expect(items).toHaveLength(3)
    const byTitle = w.byTitleIn(items)
    expect(byTitle(EXE)).toMatchObject({ poStatus: 'completed', poTitle: 'Gerar o instalador EXE' })
    expect(byTitle('Publicar o EXE no release')).toMatchObject({ origin: 'po', sourceStatus: 'completed' })
    expect(boardItemStatus(byTitle('Assinar o EXE'))).toBe('pending')
    expect(boardItemAwaitingBadge(byTitle('Assinar o EXE'))).toBeNull()
  })

  it('nenhuma operação do fechamento rebaixa: ANDAMENTO e NOVA duplicada caem; TITULO sozinho só renomeia', async () => {
    const w = await world((card) =>
      [
        `TITULO ${card(EXE).id} | Gerar o instalador EXE`,
        `ANDAMENTO ${card(LOGIN).id} | o login voltou a ser mexido`,
        `NOVA | ${LOGIN} | recriar a revisão do login`
      ].join('\n')
    )
    await w.workTurn([
      [EXE, 'in_progress'],
      [LOGIN, 'completed']
    ])

    await w.closeTurnWithLatePo()

    const items = await w.snapshot()
    expect(items).toHaveLength(2)
    const byTitle = w.byTitleIn(items)
    // O concluído do agente continua concluído: fechamento não tem ANDAMENTO,
    // e o título repetido não vira cartão novo.
    expect(boardItemStatus(byTitle(LOGIN))).toBe('completed')
    // O TITULO atrasado grava o nome e não mexe no estado: o cartão continua o
    // "a fazer" do fim de turno, esperando o usuário.
    expect(byTitle(EXE)).toMatchObject({
      poTitle: 'Gerar o instalador EXE',
      poStatus: 'pending',
      poReason: BOARD_TURN_END_REASON.result
    })
    expect(boardItemAwaitingBadge(byTitle(EXE))?.label).toBe('Aguardando você')
  })
})
