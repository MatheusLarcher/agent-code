// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { BoardService } from '../board/boardService'
import { TaskLedger } from './taskLedger'
import { buildTaskTools } from './taskTools'
import { boardStatusForTask, heldBoardItemIds } from './taskBoardSync'

/**
 * Repositório e BoardService REAIS: o vínculo depende da FK de
 * `task_board_links` e a coluna do cartão, do `applyBoardPo` — um dublê só
 * provaria que os argumentos foram repassados.
 */

type Tool = ReturnType<typeof buildTaskTools>[number]
type Result = { content: { type: string; text?: string }[] }

const PROJECT = 'proj-1'
const tempDirs: string[] = []

async function setup() {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-task-board-'))
  tempDirs.push(cache)
  const repo = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'device-a')
  await repo.initialize()
  const board = new BoardService({ repository: () => repo })
  // A identidade real exige uma pasta de verdade; aqui ela é fixa.
  board.projectId = async () => PROJECT
  const ledger = new TaskLedger(repo)
  ledger.attachBoard(board)
  const tools = buildTaskTools({ ledger, conversationId: 'conv-1', projectCwd: 'C:/projeto', agent: 'session:conv-1' })
  const call = (name: string, args: unknown): Promise<string> =>
    (tools.find((t: Tool) => t.name === name)!.handler(args as never, undefined) as Promise<Result>).then((r) =>
      r.content.map((p) => p.text ?? '').join('\n')
    )
  const cards = () => repo.listBoardItems({ projectIds: [PROJECT], includeDismissed: true })
  return { repo, board, ledger, call, cards }
}

const idOf = (created: string) => /Tarefa criada: (\S+)/.exec(created)![1]

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('tarefas do registro no Quadro', () => {
  it('task_create sem board_item_id cria o cartão com o título da tarefa e o vincula', async () => {
    const { ledger, call, cards } = await setup()
    const created = await call('task_create', { title: 'Corrigir login', goal: 'G' })
    const id = idOf(created)
    const [card] = await cards()
    expect(await cards()).toHaveLength(1)
    expect(card.poTitle ?? card.sourceTitle).toBe('Corrigir login')
    expect(card.poStatus ?? card.sourceStatus).toBe('pending')
    expect(card.conversationId).toBe('conv-1')
    expect((await ledger.boardItemIdsForTasks([id])).get(id)).toBe(card.id)
    expect(created).toContain(`vinculada ao cartão ${card.id}`)
  })

  it('task_create com board_item_id vincula ao cartão existente sem criar outro', async () => {
    const { board, ledger, call, cards } = await setup()
    const existing = (await board.createPoItem({
      projectId: PROJECT, projectCwd: 'C:/projeto', conversationId: 'conv-1', title: 'Cartão do usuário', status: 'pending', reason: 'r'
    }))!
    const id = idOf(await call('task_create', { title: 'T', goal: 'G', board_item_id: existing.id }))
    expect((await cards()).map((c) => c.id)).toEqual([existing.id])
    expect((await ledger.boardItemIdsForTasks([id])).get(id)).toBe(existing.id)
  })

  it('cada transição move o cartão: fazendo, concluído; falha volta para a fazer com o motivo', async () => {
    const { call, cards } = await setup()
    const id = idOf(await call('task_create', { title: 'T', goal: 'G' }))
    const claim = await call('task_claim', { task_id: id })
    const fence = {
      lease_token: /lease_token: (\S+)/.exec(claim)![1],
      fencing_epoch: Number(/fencing_epoch: (\d+)/.exec(claim)![1])
    }
    const status = async () => {
      const [card] = await cards()
      return card.poStatus ?? card.sourceStatus
    }

    await call('task_transition', { task_id: id, from: 'pending', to: 'running', ...fence })
    expect(await status()).toBe('in_progress')
    await call('task_transition', { task_id: id, from: 'running', to: 'failed', reason: 'testes quebraram', ...fence })
    expect(await status()).toBe('pending')
    expect((await cards())[0].poReason).toContain('testes quebraram')

    await call('task_transition', { task_id: id, from: 'failed', to: 'pending' })
    const again = await call('task_claim', { task_id: id })
    const fence2 = {
      lease_token: /lease_token: (\S+)/.exec(again)![1],
      fencing_epoch: Number(/fencing_epoch: (\d+)/.exec(again)![1])
    }
    await call('task_transition', { task_id: id, from: 'pending', to: 'running', ...fence2 })
    await call('task_transition', { task_id: id, from: 'running', to: 'review', ...fence2 })
    expect(await status()).toBe('in_progress')
    await call('task_transition', { task_id: id, from: 'review', to: 'done' })
    expect(await status()).toBe('completed')
    expect(await cards()).toHaveLength(1)
  })

  it('cancelada dispensa o cartão; tarefa criada com cartão existente também acompanha', async () => {
    const { board, ledger, call, cards } = await setup()
    const existing = (await board.createPoItem({
      projectId: PROJECT, projectCwd: 'C:/projeto', conversationId: 'conv-1', title: 'Do usuário', status: 'pending', reason: 'r'
    }))!
    const id = idOf(await call('task_create', { title: 'T', goal: 'G', board_item_id: existing.id }))
    const claim = (await ledger.claimTask('x', { taskId: id }))!
    const fence = { token: claim.token, fencingEpoch: claim.fencingEpoch }
    await ledger.transitionTask(id, 'pending', 'running', fence)
    expect((await cards())[0].poStatus).toBe('in_progress')
    await ledger.transitionTask(id, 'running', 'cancelled', fence)
    expect((await cards())[0].dismissedAt).not.toBeNull()
  })

  it('sem quadro ligado, criar e transicionar seguem funcionando', async () => {
    const { ledger, call, cards } = await setup()
    ledger.attachBoard(null)
    const created = await call('task_create', { title: 'T', goal: 'G' })
    expect(created).toContain('Tarefa criada')
    expect(created).not.toContain('vinculada')
    expect(await cards()).toHaveLength(0)
  })

  it('fim de turno com PO ligado não rebaixa o cartão de tarefa em andamento; cartão comum é reaberto', async () => {
    const { board, ledger, call, cards } = await setup()
    const plain = (await board.createPoItem({
      projectId: PROJECT, projectCwd: 'C:/projeto', conversationId: 'conv-1', title: 'Comum', status: 'in_progress', reason: 'r'
    }))!
    const statusOf = async (cardId: string) => {
      const card = (await cards()).find((c) => c.id === cardId)!
      return card.poStatus ?? card.sourceStatus
    }
    const turnEnd = async () => {
      board.observe('conv-1', 'C:/projeto', { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 })
      await board.turnClosed('conv-1')
    }
    const id = idOf(await call('task_create', { title: 'T', goal: 'G' }))
    const taskCard = (await ledger.boardItemIdsForTasks([id])).get(id)!
    const claim = (await ledger.claimTask('x', { taskId: id }))!
    const fence = { token: claim.token, fencingEpoch: claim.fencingEpoch }

    await ledger.transitionTask(id, 'pending', 'running', fence)
    await turnEnd()
    expect(await statusOf(taskCard)).toBe('in_progress')
    expect(await statusOf(plain.id)).toBe('pending')

    await ledger.transitionTask(id, 'running', 'review', fence, { reason: 'pronto para revisar' })
    await turnEnd()
    expect(await statusOf(taskCard)).toBe('in_progress')
  })

  it('motivo reescrito pelo PO não faz o cartão da tarefa em andamento ser rebaixado; o comum é reaberto', async () => {
    const { board, ledger, call, cards } = await setup()
    const statusOf = async (cardId: string) => {
      const card = (await cards()).find((c) => c.id === cardId)!
      return card.poStatus ?? card.sourceStatus
    }
    const id = idOf(await call('task_create', { title: 'T', goal: 'G' }))
    const taskCard = (await ledger.boardItemIdsForTasks([id])).get(id)!
    const claim = (await ledger.claimTask('x', { taskId: id }))!
    await ledger.transitionTask(id, 'pending', 'running', { token: claim.token, fencingEpoch: claim.fencingEpoch })
    // O PO (ou o usuário) troca o motivo mantendo "fazendo": o vínculo continua.
    await board.applyPo({ id: taskCard, poStatus: 'in_progress', poReason: 'o PO viu o agente trabalhando nisto', actor: 'po' })
    const plain = (await board.createPoItem({
      projectId: PROJECT, projectCwd: 'C:/projeto', conversationId: 'conv-1', title: 'Comum', status: 'in_progress', reason: 'r'
    }))!
    expect((await cards()).find((c) => c.id === taskCard)!.poReason).toBe('o PO viu o agente trabalhando nisto')

    board.observe('conv-1', 'C:/projeto', { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 })
    await board.turnClosed('conv-1')

    expect(await statusOf(taskCard)).toBe('in_progress')
    expect(await statusOf(plain.id)).toBe('pending')
  })

  it('heldBoardItemIds devolve só os cartões de tarefas em andamento', async () => {
    const { repo, ledger, call } = await setup()
    const running = idOf(await call('task_create', { title: 'A', goal: 'G' }))
    const waiting = idOf(await call('task_create', { title: 'B', goal: 'G' }))
    const claim = (await ledger.claimTask('x', { taskId: running }))!
    await ledger.transitionTask(running, 'pending', 'running', { token: claim.token, fencingEpoch: claim.fencingEpoch })
    const links = await ledger.boardItemIdsForTasks([running, waiting])

    expect(await heldBoardItemIds(repo, 'C:/projeto', '')).toEqual(new Set([links.get(running)]))
    expect(await heldBoardItemIds(repo, 'C:/outro', '')).toEqual(new Set())
    // A pasta de outro PC gravada sob a mesma identidade também conta.
    await repo.recordProjectIdentity({ projectCwd: 'C:/projeto', projectId: 'id-1', signature: 's' })
    expect(await heldBoardItemIds(repo, 'D:/clone', 'id-1')).toEqual(new Set([links.get(running)]))
  })

  it('mapeia cada estado da tarefa para uma coluna', () => {
    expect(boardStatusForTask('pending')).toBe('pending')
    expect(boardStatusForTask('running')).toBe('in_progress')
    expect(boardStatusForTask('review')).toBe('in_progress')
    expect(boardStatusForTask('blocked')).toBe('in_progress')
    expect(boardStatusForTask('done')).toBe('completed')
    expect(boardStatusForTask('failed')).toBe('pending')
    expect(boardStatusForTask('cancelled')).toBeNull()
  })
})
