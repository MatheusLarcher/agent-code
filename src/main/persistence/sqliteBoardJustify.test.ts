// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteRepository } from './sqliteRepository'
import { SQLITE_MIGRATIONS } from './sqliteSchema'
import type { BoardSourceItem } from './types'

/**
 * O histórico sempre registra: motivo gravado sem mudança de status vira o
 * evento `justified`, o TITULO leva o motivo na nota, e as regras automáticas
 * gravam actor `system` (com nota), não `po`.
 */

const tempDirs: string[] = []

async function repo(): Promise<SqliteRepository> {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-board-justify-'))
  tempDirs.push(cache)
  const repository = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'device-a')
  await repository.initialize()
  return repository
}

function source(sourceId: string, title: string, status: BoardSourceItem['status']): BoardSourceItem {
  return { sourceId, title, status, activeForm: null, seq: 0 }
}

async function oneCard(repository: SqliteRepository, status: BoardSourceItem['status'], title = 'uma') {
  const [card] = await repository.syncBoardItems({
    projectId: 'proj-1',
    projectCwd: 'C:/GitHub/agent-code',
    conversationId: 'conv-1',
    items: [source('1', title, status)]
  })
  return card
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('SqliteRepository — motivo sem mudança de status', () => {
  it('só o motivo (PENDENTE) vira "justified" com from=to e o status não muda', async () => {
    const repository = await repo()
    const card = await oneCard(repository, 'in_progress')
    const item = await repository.applyBoardPo({
      id: card.id,
      poReason: 'o turno terminou sem concluir esta tarefa — falta commitar',
      eventNote: 'falta commitar'
    })

    expect(item.poStatus).toBeNull()
    expect(item.poReason).toBe('o turno terminou sem concluir esta tarefa — falta commitar')
    const events = await repository.listBoardItemEvents(card.id)
    expect(events.at(-1)).toMatchObject({
      kind: 'justified',
      actor: 'po',
      fromStatus: 'in_progress',
      toStatus: 'in_progress',
      note: 'falta commitar'
    })
  })

  it('status igual ao efetivo com motivo novo também registra; o mesmo motivo de novo não', async () => {
    const repository = await repo()
    const card = await oneCard(repository, 'in_progress')
    await repository.applyBoardPo({ id: card.id, poStatus: 'in_progress', poReason: 'o usuário retomou a conversa' })
    await repository.applyBoardPo({ id: card.id, poStatus: 'in_progress', poReason: 'o usuário retomou a conversa' })

    const events = await repository.listBoardItemEvents(card.id)
    expect(events.map((e) => e.kind)).toEqual(['created', 'justified'])
    expect(events[1].note).toBe('o usuário retomou a conversa')
  })

  it('TITULO com motivo grava po_reason e a nota "título → …: motivo"', async () => {
    const repository = await repo()
    const card = await oneCard(repository, 'completed', 'add board table 5/7')
    const item = await repository.applyBoardPo({
      id: card.id,
      poTitle: 'Criar a tabela do quadro',
      poReason: 'o título do agente era técnico demais'
    })

    expect(item.poReason).toBe('o título do agente era técnico demais')
    const events = await repository.listBoardItemEvents(card.id)
    expect(events.at(-1)).toMatchObject({
      kind: 'retitled',
      actor: 'po',
      note: 'título → "Criar a tabela do quadro": o título do agente era técnico demais'
    })
  })
})

describe('SqliteRepository — autoria das regras automáticas', () => {
  it('actor "system" é aceito na mudança de status', async () => {
    const repository = await repo()
    const card = await oneCard(repository, 'in_progress')
    await repository.applyBoardPo({
      id: card.id,
      poStatus: 'pending',
      poReason: 'o turno terminou sem concluir esta tarefa',
      actor: 'system'
    })
    const events = await repository.listBoardItemEvents(card.id)
    expect(events.at(-1)).toMatchObject({ kind: 'status_changed', actor: 'system', toStatus: 'pending' })
  })

  it('dispensar/restaurar gravam "system" com a nota dada — e "system" por padrão', async () => {
    const repository = await repo()
    const card = await oneCard(repository, 'completed')
    await repository.dismissBoardItem(card.id, true, { actor: 'system', note: 'concluído há mais de 5 dias' })
    await repository.dismissBoardItem(card.id, false)

    const events = await repository.listBoardItemEvents(card.id)
    expect(events.slice(1)).toEqual([
      expect.objectContaining({ kind: 'dismissed', actor: 'system', note: 'concluído há mais de 5 dias' }),
      expect.objectContaining({ kind: 'restored', actor: 'system', note: null })
    ])
  })
})

describe('SqliteRepository — migration 12 é aditiva (justified + system)', () => {
  it('eventos antigos continuam legíveis e os valores novos passam a ser aceitos', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'agent-code-board-migration12-'))
    tempDirs.push(cache)
    const dbPath = join(cache, 'agent-code.db')
    const appliedAt = new Date().toISOString()

    // Banco parado na migration 11 — antes de `justified`/`system`.
    const pre = new DatabaseSync(dbPath)
    const before = SQLITE_MIGRATIONS.filter((m) => m.version <= 11)
    for (const entry of before) pre.exec(entry.sql)
    const insertMigration = pre.prepare(
      'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES(?, ?, ?, ?)'
    )
    for (const entry of before) insertMigration.run(entry.version, entry.name, entry.checksum, appliedAt)
    pre.prepare(
      `INSERT INTO board_items(
         id, project_id, project_cwd, conversation_id, origin, source_id, source_title, source_status,
         seq, revision, created_at, updated_at
       ) VALUES(?, ?, ?, ?, 'agent', ?, ?, ?, ?, 1, ?, ?)`
    ).run('bi-old', 'proj-1', 'C:/GitHub/agent-code', 'conv-1', '1', 'uma', 'in_progress', 0, appliedAt, appliedAt)
    pre.prepare(
      `INSERT INTO board_item_events(id, board_item_id, at, kind, actor, from_status, to_status, note)
       VALUES(?, 'bi-old', ?, 'status_changed', 'user', 'pending', 'in_progress', ?)`
    ).run('bie-old', appliedAt, 'motivo antigo')
    pre.close()

    const repository = new SqliteRepository(cache, dbPath, 'device-a')
    await repository.initialize()

    expect(await repository.listBoardItemEvents('bi-old')).toEqual([
      expect.objectContaining({ kind: 'status_changed', actor: 'user', note: 'motivo antigo' })
    ])
    await repository.applyBoardPo({ id: 'bi-old', poReason: 'falta commitar' })
    await repository.applyBoardPo({ id: 'bi-old', poStatus: 'pending', poReason: 'fim de turno', actor: 'system' })
    const after = await repository.listBoardItemEvents('bi-old')
    expect(after.slice(1)).toEqual([
      expect.objectContaining({ kind: 'justified', actor: 'po' }),
      expect.objectContaining({ kind: 'status_changed', actor: 'system' })
    ])
  })
})
