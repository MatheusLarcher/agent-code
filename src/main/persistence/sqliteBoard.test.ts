// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteRepository } from './sqliteRepository'
import type { BoardSourceItem } from './types'

const tempDirs: string[] = []

async function repo(): Promise<SqliteRepository> {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-board-'))
  tempDirs.push(cache)
  const repository = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'device-a')
  await repository.initialize()
  return repository
}

function source(sourceId: string, title: string, status: BoardSourceItem['status'], seq = 0): BoardSourceItem {
  return { sourceId, title, status, activeForm: null, seq }
}

function sync(
  repository: SqliteRepository,
  items: BoardSourceItem[],
  patch: { projectId?: string; conversationId?: string } = {}
) {
  return repository.syncBoardItems({
    projectId: patch.projectId ?? 'proj-1',
    projectCwd: 'C:/GitHub/agent-code',
    conversationId: patch.conversationId ?? 'conv-1',
    items
  })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('SqliteRepository — quadro de tarefas', () => {
  it('ingere o snapshot do agente e o devolve ordenado', async () => {
    const repository = await repo()
    const items = await sync(repository, [
      source('1', 'primeira', 'completed', 0),
      source('2', 'segunda', 'in_progress', 1),
      source('3', 'terceira', 'pending', 2)
    ])
    expect(items.map((entry) => entry.sourceTitle)).toEqual(['segunda', 'terceira', 'primeira'])
    expect(items.every((entry) => entry.origin === 'agent')).toBe(true)
  })

  it('reingerir o mesmo snapshot não duplica cartão nem infla a revisão', async () => {
    const repository = await repo()
    await sync(repository, [source('1', 'uma', 'pending')])
    const first = await sync(repository, [source('1', 'uma', 'pending')])
    expect(first).toHaveLength(1)
    expect(first[0].revision).toBe(1)
  })

  it('o status novo do agente atravessa a ingestão', async () => {
    const repository = await repo()
    await sync(repository, [source('1', 'uma', 'pending')])
    const updated = await sync(repository, [source('1', 'uma', 'completed')])
    expect(updated[0].sourceStatus).toBe('completed')
    expect(updated[0].revision).toBe(2)
  })

  it('a correção do PO SOBREVIVE à próxima leitura do snapshot', async () => {
    const repository = await repo()
    const [card] = await sync(repository, [source('1', 'add board table + migration 5/7', 'pending')])
    await repository.applyBoardPo({
      id: card.id,
      poTitle: 'Criar a tabela do quadro e a migration',
      poStatus: 'completed',
      poReason: 'o agente concluiu e esqueceu de marcar'
    })

    // O agente reescreve a lista inteira a cada mudança — é exatamente aqui que
    // uma ingestão descuidada apagaria a correção.
    const after = await sync(repository, [source('1', 'add board table + migration 5/7', 'pending')])

    expect(after[0].poTitle).toBe('Criar a tabela do quadro e a migration')
    expect(after[0].poStatus).toBe('completed')
    expect(after[0].poReason).toBe('o agente concluiu e esqueceu de marcar')
    expect(after[0].sourceStatus).toBe('pending')
  })

  it('o quadro destrava quando o agente volta a trabalhar no cartão reaberto', async () => {
    const repository = await repo()
    // 1. o agente começa a tarefa
    const [card] = await sync(repository, [source('1', 'uma', 'in_progress')])
    // 2. o turno acaba sem que ela tenha sido concluída: volta para "a fazer"
    await repository.applyBoardPo({
      id: card.id,
      poStatus: 'pending',
      poReason: 'o turno terminou sem concluir esta tarefa'
    })
    expect((await repository.listBoardItems({ projectIds: ['proj-1'] }))[0].poStatus).toBe('pending')

    // 3. o agente retoma e declara a tarefa em andamento de novo — sem soltar a
    //    camada do PO, o cartão ficaria "a fazer" com o agente trabalhando nele.
    const after = await sync(repository, [source('1', 'uma', 'in_progress')])

    expect(after[0].sourceStatus).toBe('in_progress')
    expect(after[0].poStatus).toBeNull()
    expect(after[0].poReason).toBeNull()
  })

  it('o título que o PO reescreveu sobrevive à mudança de status — título não é estado', async () => {
    const repository = await repo()
    const [card] = await sync(repository, [source('1', 'add board table 5/7', 'pending')])
    await repository.applyBoardPo({
      id: card.id,
      poTitle: 'Criar a tabela do quadro',
      poNote: 'inclui a migration',
      poStatus: 'completed',
      poReason: 'o agente concluiu e esqueceu de marcar'
    })

    const after = await sync(repository, [source('1', 'add board table 5/7', 'in_progress')])

    expect(after[0].poTitle).toBe('Criar a tabela do quadro')
    expect(after[0].poNote).toBe('inclui a migration')
    expect(after[0].poStatus).toBeNull()
  })

  it('snapshot vazio NÃO apaga o quadro', async () => {
    const repository = await repo()
    await sync(repository, [source('1', 'uma', 'pending')])
    const after = await sync(repository, [])
    expect(after).toHaveLength(1)
  })

  it('tarefa que sumiu do snapshot sai do quadro, mas o cartão do PO fica', async () => {
    const repository = await repo()
    await sync(repository, [source('1', 'uma', 'pending'), source('2', 'duas', 'pending', 1)])
    await repository.createBoardPoItem({
      projectId: 'proj-1',
      projectCwd: 'C:/GitHub/agent-code',
      conversationId: 'conv-1',
      title: 'testar com duas conversas',
      status: 'pending',
      reason: 'surgiu no meio do trabalho'
    })

    const after = await sync(repository, [source('1', 'uma', 'pending')])

    expect(after.map((entry) => entry.sourceTitle).sort()).toEqual(['testar com duas conversas', 'uma'])
    expect(after.some((entry) => entry.origin === 'po')).toBe(true)
  })

  it('o quadro é por projeto: outro projeto não enxerga estes cartões', async () => {
    const repository = await repo()
    await sync(repository, [source('1', 'uma', 'pending')])
    expect(await repository.listBoardItems({ projectIds: ['outro'] })).toEqual([])
    expect(await repository.listBoardItems({ projectIds: [] })).toEqual([])
  })

  it('duas conversas do mesmo projeto compartilham o quadro e dá para filtrar por uma', async () => {
    const repository = await repo()
    await sync(repository, [source('1', 'da conversa A', 'pending')], { conversationId: 'conv-a' })
    await sync(repository, [source('1', 'da conversa B', 'pending')], { conversationId: 'conv-b' })

    const all = await repository.listBoardItems({ projectIds: ['proj-1'] })
    expect(all).toHaveLength(2)
    const onlyA = await repository.listBoardItems({ projectIds: ['proj-1'], conversationId: 'conv-a' })
    expect(onlyA.map((entry) => entry.sourceTitle)).toEqual(['da conversa A'])
  })

  it('cartão dispensado some da lista sem ser apagado', async () => {
    const repository = await repo()
    const [card] = await sync(repository, [source('1', 'uma', 'pending')])
    await repository.dismissBoardItem(card.id, true)

    expect(await repository.listBoardItems({ projectIds: ['proj-1'] })).toEqual([])
    const withDismissed = await repository.listBoardItems({ projectIds: ['proj-1'], includeDismissed: true })
    expect(withDismissed).toHaveLength(1)
    expect(withDismissed[0].dismissedAt).not.toBeNull()

    await repository.dismissBoardItem(card.id, false)
    expect(await repository.listBoardItems({ projectIds: ['proj-1'] })).toHaveLength(1)
  })

  it('mudança de status pelo PO sem motivo é recusada antes de tocar o banco', async () => {
    const repository = await repo()
    const [card] = await sync(repository, [source('1', 'uma', 'pending')])
    await expect(repository.applyBoardPo({ id: card.id, poStatus: 'completed' })).rejects.toThrow(/motivo/i)
    const after = await repository.listBoardItems({ projectIds: ['proj-1'] })
    expect(after[0].poStatus).toBeNull()
  })

  it('escrever num cartão inexistente é erro, não criação silenciosa', async () => {
    const repository = await repo()
    await expect(repository.applyBoardPo({ id: 'bi-nao-existe', poTitle: 'x' })).rejects.toThrow(/inexistente/i)
  })

  it('notifica a mudança pelo change feed para a tela se atualizar sozinha', async () => {
    const repository = await repo()
    const seen: string[] = []
    repository.subscribe((changes) => {
      for (const change of changes) if (change.entity === 'board') seen.push(change.entityId)
    })
    await sync(repository, [source('1', 'uma', 'pending')])
    expect(seen).toHaveLength(1)
  })
})
