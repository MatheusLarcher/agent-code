// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { TaskLedger } from './taskLedger'
import { buildTaskBoard, buildTaskDetail, sortBoardItems, summarizeData } from './taskBoard'
import type { TaskBoardItem } from '../../shared/ipc'

/**
 * Contra um SqliteRepository REAL, como o resto do registro: o que a projeção
 * precisa provar é que mostra o estado que o banco de fato tem — um dublê
 * provaria só que os campos foram copiados.
 */

const tempDirs: string[] = []

async function setup(): Promise<{ ledger: TaskLedger; repository: SqliteRepository }> {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-task-board-'))
  tempDirs.push(cache)
  const repository = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'device-a')
  await repository.initialize()
  return { ledger: new TaskLedger(repository), repository }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('projeção do registro de tarefas para o painel', () => {
  it('sem repositório autoritativo, reporta indisponível em vez de fila vazia', async () => {
    expect(await buildTaskBoard(null)).toEqual({ available: false, items: [] })
    expect(await buildTaskDetail(null, 'tsk-1')).toBeNull()
  })

  it('banco ligado e sem tarefa nenhuma é disponível com fila vazia', async () => {
    const { ledger } = await setup()
    expect(await buildTaskBoard(ledger)).toEqual({ available: true, items: [] })
  })

  it('lista a tarefa do projeto com escopo, tentativas e critérios', async () => {
    const { ledger } = await setup()
    await ledger.createTask({
      projectCwd: 'C:/projeto',
      title: 'Painel de tarefas',
      goal: 'Expor a fila',
      acceptance: ['agrupa por estado', 'typecheck passa'],
      writeScope: { allow: ['src/renderer/**'], deny: ['src/main/**'] }
    })

    const board = await buildTaskBoard(ledger, { projectCwd: 'C:/projeto' })
    expect(board.available).toBe(true)
    expect(board.items).toHaveLength(1)
    const item = board.items[0]
    expect(item.title).toBe('Painel de tarefas')
    expect(item.status).toBe('pending')
    expect(item.acceptance).toEqual(['agrupa por estado', 'typecheck passa'])
    expect(item.writeScopeAllow).toEqual(['src/renderer/**'])
    expect(item.writeScopeDeny).toEqual(['src/main/**'])
    expect(item.attempts).toBe(0)
    expect(item.leaseExpiresAt).toBeNull()
    // `pending` não paga a consulta de evidência: null é "não contei", não "zero".
    expect(item.deliverables).toBeNull()
  })

  it('não mistura projeto: o filtro é o da conversa', async () => {
    const { ledger } = await setup()
    await ledger.createTask({ projectCwd: 'C:/a', title: 'do A', goal: 'g' })
    await ledger.createTask({ projectCwd: 'C:/b', title: 'do B', goal: 'g' })

    const board = await buildTaskBoard(ledger, { projectCwd: 'C:/a' })
    expect(board.items.map((item) => item.title)).toEqual(['do A'])
  })

  it('tarefa reivindicada mostra dono e lease vivo', async () => {
    const { ledger } = await setup()
    await ledger.createTask({ projectCwd: 'C:/projeto', title: 'em execução', goal: 'g' })
    const claim = await ledger.claimTask('session:conv-1', { projectCwd: 'C:/projeto' })
    expect(claim).not.toBeNull()

    const board = await buildTaskBoard(ledger, { projectCwd: 'C:/projeto' })
    const item = board.items[0]
    expect(item.ownerAgent).toBe('session:conv-1')
    expect(item.leaseExpiresAt).not.toBeNull()
    expect(Date.parse(item.leaseExpiresAt as string)).toBeGreaterThan(Date.now())
    expect(item.attempts).toBe(1)
  })

  it('em review, conta a evidência — inclusive quando não há nenhuma', async () => {
    const { ledger } = await setup()
    const task = await ledger.createTask({ projectCwd: 'C:/projeto', title: 'entregue', goal: 'g' })
    const claim = await ledger.claimTask('session:conv-1', { projectCwd: 'C:/projeto' })
    const fence = { token: claim!.token, fencingEpoch: claim!.fencingEpoch }
    await ledger.transitionTask(task.id, 'pending', 'running', fence)

    const vazio = await buildTaskBoard(ledger, { projectCwd: 'C:/projeto' })
    // `running` não conta evidência — só review/done, onde a ausência é acionável.
    expect(vazio.items[0].deliverables).toBeNull()

    await ledger.addDeliverable({
      taskId: task.id,
      kind: 'test_run',
      summary: '31 passaram',
      fence
    })
    await ledger.transitionTask(task.id, 'running', 'review', fence, { reason: 'entregue' })

    const board = await buildTaskBoard(ledger, { projectCwd: 'C:/projeto' })
    expect(board.items[0].status).toBe('review')
    expect(board.items[0].deliverables).toBe(1)
    // review SOLTA o lease — e o repositório expressa isso expirando a data, não
    // limpando o token. O painel não pode dizer que alguém ainda está segurando.
    expect(board.items[0].leaseExpiresAt).not.toBeNull()
    expect(Date.parse(board.items[0].leaseExpiresAt as string)).toBeLessThanOrEqual(Date.now())
  })

  it('mostra as terminadas por padrão e permite recorte só das abertas', async () => {
    const { ledger } = await setup()
    const task = await ledger.createTask({ projectCwd: 'C:/projeto', title: 'terminada', goal: 'g' })
    const claim = await ledger.claimTask('session:conv-1', { projectCwd: 'C:/projeto' })
    const fence = { token: claim!.token, fencingEpoch: claim!.fencingEpoch }
    await ledger.transitionTask(task.id, 'pending', 'running', fence)
    await ledger.transitionTask(task.id, 'running', 'review', fence)
    await ledger.transitionTask(task.id, 'review', 'done')

    const all = await buildTaskBoard(ledger, { projectCwd: 'C:/projeto' })
    expect(all.items.map((item) => item.status)).toEqual(['done'])
    const open = await buildTaskBoard(ledger, { projectCwd: 'C:/projeto', includeFinished: false })
    expect(open.items).toHaveLength(0)
    // `done` sem evidência é um "done" que é só afirmação — por isso conta.
    expect(all.items[0].deliverables).toBe(0)
  })

  it('mostra o cartão vinculado, e null quando não há vínculo', async () => {
    const { ledger, repository } = await setup()
    const vinculada = await ledger.createTask({ projectCwd: 'C:/projeto', title: 'vinculada', goal: 'g' })
    await ledger.createTask({ projectCwd: 'C:/projeto', title: 'solta', goal: 'g' })
    const card = await repository.createBoardPoItem({
      projectId: 'proj-1',
      projectCwd: 'C:/projeto',
      conversationId: 'conv-1',
      title: 'cartão do PO',
      status: 'pending',
      reason: 'setup do teste'
    })
    await ledger.linkTaskToBoardItem({ taskId: vinculada.id, boardItemId: card.id, linkedBy: 'po' })

    const board = await buildTaskBoard(ledger, { projectCwd: 'C:/projeto' })
    const byTitle = new Map(board.items.map((item) => [item.title, item.boardItemId]))
    expect(byTitle.get('vinculada')).toBe(card.id)
    expect(byTitle.get('solta')).toBeNull()
  })

  it('filtra por conversationId sem misturar outras conversas do mesmo projeto', async () => {
    const { ledger } = await setup()
    await ledger.createTask({
      projectCwd: 'C:/projeto',
      conversationId: 'conv-1',
      title: 'da conversa 1',
      goal: 'g'
    })
    await ledger.createTask({
      projectCwd: 'C:/projeto',
      conversationId: 'conv-2',
      title: 'da conversa 2',
      goal: 'g'
    })

    const board = await buildTaskBoard(ledger, { projectCwd: 'C:/projeto', conversationId: 'conv-1' })
    expect(board.items.map((item) => item.title)).toEqual(['da conversa 1'])
  })

  it('o detalhe traz passos, evidências e eventos da tarefa', async () => {
    const { ledger } = await setup()
    const task = await ledger.createTask({ projectCwd: 'C:/projeto', title: 'com detalhe', goal: 'g' })
    const claim = await ledger.claimTask('session:conv-1', { projectCwd: 'C:/projeto' })
    const fence = { token: claim!.token, fencingEpoch: claim!.fencingEpoch }
    await ledger.transitionTask(task.id, 'pending', 'running', fence)
    const step = await ledger.appendStep({ taskId: task.id, kind: 'implement', agent: 'exec', fence })
    await ledger.finishStep({ stepId: step.id, status: 'done', fence })
    await ledger.addDeliverable({ taskId: task.id, kind: 'diff', summary: '4 arquivos', fence })

    const detail = await buildTaskDetail(ledger, task.id)
    expect(detail?.steps.map((s) => s.kind)).toEqual(['implement'])
    expect(detail?.steps[0].finishedAt).not.toBeNull()
    expect(detail?.deliverables.map((d) => d.summary)).toEqual(['4 arquivos'])
    // Toda mutação gera evento — é o rastro que o crítico lê.
    expect(detail!.events.length).toBeGreaterThan(0)
  })
})

describe('ordenação e resumo', () => {
  const base: Omit<TaskBoardItem, 'id' | 'status' | 'updatedAt'> = {
    title: 't',
    goal: 'g',
    acceptance: [],
    ownerAgent: null,
    writeScopeAllow: [],
    writeScopeDeny: [],
    attempts: 0,
    maxAttempts: 3,
    leaseExpiresAt: null,
    conversationId: null,
    projectCwd: 'C:/p',
    createdAt: '2026-09-11T00:00:00.000Z',
    deliverables: null,
    boardItemId: null
  }
  const at = (status: TaskBoardItem['status'], id: string, updatedAt: string): TaskBoardItem => ({
    ...base,
    id,
    status,
    updatedAt
  })

  it('põe na frente quem espera uma pessoa, e não o mais recente', () => {
    const sorted = sortBoardItems([
      at('pending', 'p', '2026-09-11T10:00:00.000Z'),
      at('done', 'd', '2026-09-11T11:00:00.000Z'),
      at('review', 'r', '2026-09-11T08:00:00.000Z'),
      at('running', 'x', '2026-09-11T09:00:00.000Z'),
      at('blocked', 'b', '2026-09-11T09:30:00.000Z')
    ])
    expect(sorted.map((item) => item.id)).toEqual(['r', 'x', 'b', 'p', 'd'])
  })

  it('dentro do mesmo estado, o mais recente primeiro', () => {
    const sorted = sortBoardItems([
      at('running', 'velha', '2026-09-11T08:00:00.000Z'),
      at('running', 'nova', '2026-09-11T12:00:00.000Z')
    ])
    expect(sorted.map((item) => item.id)).toEqual(['nova', 'velha'])
  })

  it('resume o blob do evento numa linha, nunca um stack trace', () => {
    expect(summarizeData({ reason: 'escopo fora do allow' }, 'x')).toBe('escopo fora do allow')
    expect(summarizeData({ from: 'running', to: 'review' }, 'x')).toBe('from, to')
    expect(summarizeData(null, 'transition')).toBe('transition')
    expect(summarizeData({ message: 'a'.repeat(300) }, 'x')).toHaveLength(160)
  })
})
