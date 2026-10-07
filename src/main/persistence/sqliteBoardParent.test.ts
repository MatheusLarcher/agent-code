// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLITE_MIGRATIONS, SQLITE_SCHEMA, SQLITE_SCHEMA_FULL } from './sqliteSchema'
import { SqliteRepository } from './sqliteRepository'

/**
 * Migration 16 — `board_items.parent_id`, o vínculo da pendência com o cartão
 * de origem. Coluna que aceita nulo: o banco antigo ganha a coluna ao reabrir, e
 * a linha que já existia continua legível, só sem pai.
 */

const base = { projectId: 'p1', projectCwd: 'C:/GitHub/agent-code', conversationId: 'conv-1' }

describe('SQLITE_MIGRATIONS — migration 16 (board_items.parent_id)', () => {
  it('roda uma vez (bootstrap/migração), nunca no guarda de write()', () => {
    const sixteen = SQLITE_MIGRATIONS.find((entry) => entry.version === 16)
    expect(sixteen).toMatchObject({ name: 'sqlite-v2-board-parent', writeGuardSql: '' })
    expect(sixteen!.sql).toMatch(/ALTER TABLE board_items ADD COLUMN parent_id TEXT/i)
    expect(SQLITE_SCHEMA).not.toMatch(/parent_id/)
    expect(SQLITE_SCHEMA_FULL).toMatch(/ADD COLUMN parent_id/)
  })

  it('banco novo: a pendência grava e lê o pai; o cartão comum continua sem o campo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-code-board-parent-'))
    try {
      const repo = new SqliteRepository(dir, join(dir, 'agent-code.db'), 'device-a')
      await repo.initialize()
      const parent = await repo.createBoardPoItem({ ...base, title: 'Implementar a fase 1', status: 'completed', reason: 'feito' })
      const child = await repo.createBoardPoItem({
        ...base,
        title: 'Commitar a fase 1',
        status: 'pending',
        reason: 'aguardando autorização do usuário',
        parentId: parent.id
      })
      expect(child.parentId).toBe(parent.id)
      expect(parent).not.toHaveProperty('parentId')
      const listed = await repo.listBoardItems({ projectIds: ['p1'] })
      expect(listed.find((item) => item.id === child.id)?.parentId).toBe(parent.id)
      expect((await repo.getBoardItem(child.id))?.parentId).toBe(parent.id)
      // As escritas do PO preservam o vínculo.
      const moved = await repo.applyBoardPo({ id: child.id, poStatus: 'in_progress', poReason: 'o usuário autorizou' })
      expect(moved.parentId).toBe(parent.id)
      await repo.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('banco antigo (parou na 15): ganha a coluna ao reabrir, e a linha de antes continua legível sem pai', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-code-board-parent-up-'))
    try {
      const dbPath = join(dir, 'agent-code.db')
      const repo = new SqliteRepository(dir, dbPath, 'device-a')
      await repo.initialize()
      const old = await repo.createBoardPoItem({ ...base, title: 'Cartão de antes', status: 'pending', reason: 'antigo' })
      await repo.close()
      // Simula a versão anterior: sem a coluna e sem o registro da 16.
      const db = new DatabaseSync(dbPath)
      try {
        db.exec('ALTER TABLE board_items DROP COLUMN parent_id; DELETE FROM schema_migrations WHERE version = 16;')
      } finally {
        db.close()
      }

      const reopened = new SqliteRepository(dir, dbPath, 'device-a')
      await reopened.initialize()
      const [before] = await reopened.listBoardItems({ projectIds: ['p1'] })
      expect(before).toMatchObject({ id: old.id, sourceTitle: 'Cartão de antes' })
      expect(before).not.toHaveProperty('parentId')
      const child = await reopened.createBoardPoItem({
        ...base,
        title: 'Commitar o cartão de antes',
        status: 'pending',
        reason: 'aguardando autorização do usuário',
        parentId: old.id
      })
      expect(child.parentId).toBe(old.id)
      await reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
