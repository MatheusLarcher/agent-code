// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BOARD_TURN_END_REASON,
  boardItemAwaitingBadge,
  type BoardConfig,
  type BoardItem,
  type ChatEvent
} from '../../shared/ipc'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { Po } from '../po/po'
import { applyPoVerdict, type PoApplyDeps, type PoApplyTarget } from '../po/poApply'
import { PO_AWAITING_AUTHORIZATION_REASON, PO_RETURNED_SECTION } from '../po/poPrompt'
import { BoardService } from './boardService'

/**
 * Ponta a ponta no SQLite real: o VOCÊ do PENDENTE sobrevive ao rebaixamento do
 * fim de turno e some na retomada; CONCLUIR, a conclusão padrão, o arrasto do
 * usuário e o agente mudando o status também o limpam.
 */

const CWD = process.cwd()
const CONV = 'conv-user-action'
const ACTION = 'Escolher entre o layout A e o B'
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function open() {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-user-action-'))
  tempDirs.push(cache)
  const repository = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'device-a')
  await repository.initialize()
  return repository
}

async function world(ask: (prompt: string) => Promise<string>) {
  const repository = await open()
  const config = (): BoardConfig => ({ requirePlan: true, po: { enabled: true, model: 'claude-sonnet-5-5' } })
  const board = new BoardService({
    repository: () => repository,
    poSettled: (id): Promise<void> => po.settled(id),
    poWaitMs: 2_000
  })
  let clock = 1_000_000
  const po: Po = new Po({
    config,
    board,
    now: () => clock,
    ask,
    gateActive: async () => false,
    scheduleFlush: () => () => undefined,
    decisionLog: () => undefined
  })
  const emit = (event: ChatEvent): void => {
    board.observe(CONV, CWD, event)
    po.observe(CONV, event)
  }
  const userSays = (text: string): Promise<void> => {
    clock += 61_000
    po.noteUserMessage(CONV, CWD, text)
    return board.resumeTurn(CONV, CWD)
  }
  const idle = async (): Promise<void> => {
    await board.settled(CONV)
    await po.settled(CONV)
    await board.turnClosed(CONV)
    await po.settled(CONV)
  }
  const cards = async (): Promise<BoardItem[]> => (await board.list(CWD, { conversationId: CONV })) ?? []
  return { emit, userSays, idle, cards }
}

const taskList = (status: 'in_progress' | 'completed'): ChatEvent => ({
  kind: 'task-list',
  items: [{ id: '1', content: 'Implementar a tela nova', status, activeForm: 'Implementando' }]
})
const reply: ChatEvent = { kind: 'assistant-text', id: 'a', text: 'Fiz dois layouts. Qual você prefere, A ou B?', final: true }
const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 }

/** PENDENTE com VOCÊ para o primeiro id da seção de devolvidos do digest. */
async function pendente(prompt: string): Promise<string> {
  const digest = prompt.split('\n---\n').at(-1) ?? ''
  const at = digest.lastIndexOf(PO_RETURNED_SECTION)
  const id = at >= 0 ? /\n- (\S+)/.exec(digest.slice(at))?.[1] : undefined
  return id ? `PENDENTE ${id} | esperando o usuário escolher o layout | VOCÊ: ${ACTION}` : 'OK'
}

describe('VOCÊ + fim de turno no SQLite real', () => {
  it('o rebaixamento mantém a ação do PENDENTE; a retomada a limpa', async () => {
    const w = await world(pendente)
    await w.userSays('faz a tela nova')
    w.emit(taskList('in_progress'))
    w.emit(reply)
    w.emit(result)
    await w.idle()

    const [card] = await w.cards()
    expect(card).toMatchObject({ poStatus: 'pending', poUserAction: ACTION })
    expect(boardItemAwaitingBadge(card)?.label).toBe('Aguardando você')

    await w.userSays('o A')
    await w.idle()
    const [resumed] = await w.cards()
    expect(resumed.poStatus).toBe('in_progress')
    expect(resumed).not.toHaveProperty('poUserAction')
  })
})

describe('o que limpa a ação', () => {
  async function setup() {
    const repository = await open()
    const board = new BoardService({ repository: () => repository })
    const projectId = await board.projectId(CWD)
    const waiting = (title: string): Promise<BoardItem> =>
      repository.createBoardPoItem({
        projectId,
        projectCwd: CWD,
        conversationId: CONV,
        title,
        status: 'pending',
        reason: PO_AWAITING_AUTHORIZATION_REASON,
        userAction: `Autorizar: ${title}`
      })
    const deps = { board, linkableLedgerTasks: async () => [] } as unknown as PoApplyDeps
    const target = (returned: BoardItem[] = []): PoApplyTarget => ({
      convId: CONV,
      cwd: CWD,
      projectId,
      phase: 'close',
      startedAt: 0,
      returned
    })
    return { repository, board, waiting, deps, target }
  }

  it('CONCLUIR e a conclusão padrão do fim de turno', async () => {
    const s = await setup()
    const concluded = await s.waiting('Commitar a fase 1')
    const byDefault = await s.waiting('Verificar a fase 1 no app')
    expect(concluded.poUserAction).toBe('Autorizar: Commitar a fase 1')

    await applyPoVerdict(s.deps, s.target(), `CONCLUIR ${concluded.id} | commit feito`, [concluded], { applied: 0, touched: [] })
    await applyPoVerdict(s.deps, s.target([byDefault]), 'OK', [byDefault], { applied: 0, touched: [] })

    for (const id of [concluded.id, byDefault.id]) {
      const item = await s.repository.getBoardItem(id)
      expect(item?.poStatus).toBe('completed')
      expect(item).not.toHaveProperty('poUserAction')
    }
  })

  it('o arrasto do usuário pelo quadro', async () => {
    const s = await setup()
    const card = await s.waiting('Testar o login no celular')
    expect(await s.board.move(card.id, 'completed')).toEqual({ ok: true })
    expect(await s.repository.getBoardItem(card.id)).not.toHaveProperty('poUserAction')
  })

  it('o agente mudando o status (o snapshot solta a camada do PO)', async () => {
    const s = await setup()
    s.board.observe(CONV, CWD, taskList('in_progress'))
    await s.board.settled(CONV)
    const [card] = (await s.board.list(CWD, { conversationId: CONV })) ?? []
    await s.repository.applyBoardPo({
      id: card.id,
      poStatus: 'pending',
      poReason: `${BOARD_TURN_END_REASON.result} — esperando o layout`,
      userAction: ACTION,
      actor: 'system'
    })
    expect((await s.repository.getBoardItem(card.id))?.poUserAction).toBe(ACTION)

    s.board.observe(CONV, CWD, taskList('completed'))
    await s.board.settled(CONV)
    const after = await s.repository.getBoardItem(card.id)
    expect(after).toMatchObject({ poStatus: null, poReason: null, sourceStatus: 'completed' })
    expect(after).not.toHaveProperty('poUserAction')
  })
})
