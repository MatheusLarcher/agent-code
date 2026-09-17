// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLITE_MIGRATIONS, SQLITE_SCHEMA, SQLITE_SCHEMA_FULL } from './sqliteSchema'
import { SqliteRepository } from './sqliteRepository'

/**
 * `SQLITE_SCHEMA` é o guarda que `SqliteRepository.write()` reexecuta a cada
 * escrita — para sempre, na vida do app. Uma migração que recria uma tabela
 * (`CREATE`+`INSERT`+`DROP`+`RENAME`, como a 7) não pode estar aí: rodar isso
 * a cada escrita comum copiaria a tabela inteira toda vez. `writeGuardSql`
 * existe para cortar esse custo — este teste garante que a migração pesada
 * nunca vaza de volta para o guarda.
 */
describe('SQLITE_SCHEMA — o guarda de write() nunca repete um recreate de tabela', () => {
  it('a migração 7 tem um writeGuardSql mais barato que o sql completo', () => {
    const seven = SQLITE_MIGRATIONS.find((entry) => entry.version === 7)
    expect(seven).toBeTruthy()
    expect(seven!.writeGuardSql).not.toBe(seven!.sql)
    // O atalho não recria a tabela — só garante o índice.
    expect(seven!.writeGuardSql).not.toMatch(/DROP TABLE|RENAME TO/i)
    expect(seven!.sql).toMatch(/DROP TABLE board_item_events/i)
  })

  it('SQLITE_SCHEMA (o guarda) não contém o recreate; SQLITE_SCHEMA_FULL contém', () => {
    expect(SQLITE_SCHEMA).not.toMatch(/DROP TABLE board_item_events/i)
    expect(SQLITE_SCHEMA_FULL).toMatch(/DROP TABLE board_item_events/i)
  })

  it('write() repetido não recria board_item_events — o histórico sobrevive a várias escritas', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-code-schema-guard-'))
    try {
      const repo = new SqliteRepository(dir, join(dir, 'agent-code.db'), 'device-a')
      await repo.initialize()
      const item = await repo.createBoardPoItem({
        projectId: 'p1',
        projectCwd: 'C:/GitHub/agent-code',
        conversationId: 'conv-1',
        title: 'uma',
        status: 'pending',
        reason: 'surgiu no meio do trabalho'
      })
      // Cada write() daqui reexecuta SQLITE_SCHEMA — se ele recriasse a
      // tabela, o histórico do cartão sumiria a cada chamada.
      await repo.dismissBoardItem(item.id, true)
      await repo.dismissBoardItem(item.id, false)
      await repo.applyBoardPo({ id: item.id, poNote: 'nota', actor: 'user' })

      const events = await repo.listBoardItemEvents(item.id)
      expect(events.map((e) => e.kind)).toEqual(['created', 'dismissed', 'restored', 'note_changed'])
      expect(events[3].actor).toBe('user')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('SQLITE_MIGRATIONS — migration 8 (task_board_links)', () => {
  it('está registrada em SQLITE_MIGRATIONS, SQLITE_SCHEMA e SQLITE_SCHEMA_FULL', () => {
    const eight = SQLITE_MIGRATIONS.find((entry) => entry.version === 8)
    expect(eight).toBeTruthy()
    expect(eight!.name).toBe('sqlite-v2-task-board-links')
    expect(SQLITE_SCHEMA).toMatch(/CREATE TABLE IF NOT EXISTS task_board_links/i)
    expect(SQLITE_SCHEMA_FULL).toMatch(/CREATE TABLE IF NOT EXISTS task_board_links/i)
  })
})
