// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLITE_MIGRATIONS, SQLITE_SCHEMA } from './sqliteSchema'
import { SqliteRepository } from './sqliteRepository'
import { BOARD_PRINT_RETENTION_MS } from './boardPrintPruner'
import type { BoardItemPrintWrite } from './boardPrintTypes'

/**
 * Migration 17 — os prints dos cartões (`board_item_prints`) no SQLite: o
 * limite de 4 por cartão, a leitura sem e com a imagem grande, e a faxina dos
 * 30 dias (concluído há mais de 30 dias e órfão saem; o reaberto fica).
 */

const base = { projectId: 'p1', projectCwd: 'C:/GitHub/loja', conversationId: 'conv-1' }
const DAY = 24 * 60 * 60_000
const NOW = Date.UTC(2026, 9, 7, 12, 0)
const iso = (ms: number): string => new Date(ms).toISOString()

function print(id: string, boardItemId: string, createdAt: string, over: Partial<BoardItemPrintWrite> = {}): BoardItemPrintWrite {
  return {
    id, boardItemId, projectId: 'p1', conversationId: 'conv-1', mime: 'image/jpeg', width: 1600, height: 900,
    legenda: `print ${id}`, createdAt, data: new Uint8Array([1, 2, 3, id.length]), thumb: new Uint8Array([9, 9]), ...over
  }
}

async function withRepo(fn: (repo: SqliteRepository, dbPath: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-code-board-prints-'))
  const dbPath = join(dir, 'agent-code.db')
  const repo = new SqliteRepository(dir, dbPath, 'device-a')
  try {
    await repo.initialize()
    await fn(repo, dbPath, dir)
  } finally {
    await repo.close().catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
}

describe('SQLITE_MIGRATIONS — migration 17 (board_item_prints)', () => {
  it('tabela nova com IF NOT EXISTS: o mesmo SQL no guarda de write()', () => {
    const seventeen = SQLITE_MIGRATIONS.find((entry) => entry.version === 17)
    expect(seventeen).toMatchObject({ name: 'sqlite-v2-board-prints' })
    expect(seventeen!.writeGuardSql).toBe(seventeen!.sql)
    expect(seventeen!.sql).toMatch(/CREATE TABLE IF NOT EXISTS board_item_prints/)
    expect(SQLITE_SCHEMA).toMatch(/board_item_prints/)
  })
})

describe('SqliteRepository — prints dos cartões', () => {
  it('fica com os 4 mais novos do cartão; lista sem a imagem grande, por projeto e por cartão; lê a grande pelo id', async () => {
    await withRepo(async (repo) => {
      const card = await repo.createBoardPoItem({ ...base, title: 'Tela de login', status: 'in_progress', reason: 'r' })
      for (let i = 1; i <= 5; i++) await repo.addBoardItemPrint(print(`p${i}`, card.id, iso(NOW + i * 60_000)), 4)
      await repo.addBoardItemPrint(print('outro', 'cartao-b', iso(NOW)), 4)
      const mine = await repo.listBoardItemPrints({ boardItemId: card.id })
      expect(mine.map((p) => p.id)).toEqual(['p5', 'p4', 'p3', 'p2'])
      expect(mine[0]).not.toHaveProperty('data')
      expect(mine[0]).toMatchObject({ legenda: 'print p5', width: 1600, bytes: 4, thumb: new Uint8Array([9, 9]) })
      expect((await repo.listBoardItemPrints({ projectId: 'p1' })).map((p) => p.id).sort()).toEqual(['outro', 'p2', 'p3', 'p4', 'p5'])
      expect(await repo.listBoardItemPrints({})).toEqual([])
      const big = await repo.getBoardItemPrint('p5')
      expect(Array.from(big!.data)).toEqual([1, 2, 3, 2])
      expect(await repo.getBoardItemPrint('p1')).toBeNull()
    })
  })

  it('faxina dos 30 dias: concluído há mais de 30 dias e órfão velho saem; reaberto e recente ficam', async () => {
    await withRepo(async (repo) => {
      const done = await repo.createBoardPoItem({ ...base, title: 'Concluída há 40 dias', status: 'completed', reason: 'r' })
      const reopened = await repo.createBoardPoItem({ ...base, title: 'Reaberta', status: 'pending', reason: 'r' })
      const fresh = await repo.createBoardPoItem({ ...base, title: 'Concluída ontem', status: 'completed', reason: 'r' })
      repo.write((db) => {
        db.prepare('UPDATE board_items SET updated_at = ? WHERE id IN (?, ?)').run(iso(NOW - 40 * DAY), done.id, reopened.id)
        db.prepare('UPDATE board_items SET updated_at = ? WHERE id = ?').run(iso(NOW - DAY), fresh.id)
      })
      const old = iso(NOW - 40 * DAY)
      await repo.addBoardItemPrint(print('velho-concluido', done.id, old), 4)
      await repo.addBoardItemPrint(print('velho-reaberto', reopened.id, old), 4)
      await repo.addBoardItemPrint(print('velho-orfao', 'cartao-que-sumiu', old), 4)
      await repo.addBoardItemPrint(print('novo-orfao', 'cartao-que-sumiu', iso(NOW - DAY)), 4)
      await repo.addBoardItemPrint(print('concluido-ontem', fresh.id, old), 4)
      const cutoff = iso(NOW - BOARD_PRINT_RETENTION_MS)
      expect(await repo.pruneBoardItemPrints(cutoff)).toBe(2)
      expect((await repo.listBoardItemPrints({ projectId: 'p1' })).map((p) => p.id).sort()).toEqual(['concluido-ontem', 'novo-orfao', 'velho-reaberto'])
      expect(await repo.pruneBoardItemPrints(cutoff)).toBe(0)
    })
  })

  it('banco antigo (parou na 16): ganha a tabela ao reabrir', async () => {
    await withRepo(async (repo, dbPath, dir) => {
      await repo.close()
      const db = new DatabaseSync(dbPath)
      db.exec('DROP TABLE board_item_prints; DELETE FROM schema_migrations WHERE version = 17;')
      db.close()
      const again = new SqliteRepository(dir, dbPath, 'device-a')
      await again.initialize()
      await again.addBoardItemPrint(print('p1', 'c1', iso(NOW)), 4)
      expect((await again.listBoardItemPrints({ boardItemId: 'c1' })).map((p) => p.id)).toEqual(['p1'])
      await again.close()
    })
  })
})
