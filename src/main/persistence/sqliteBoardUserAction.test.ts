// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLITE_MIGRATIONS, SQLITE_SCHEMA, SQLITE_SCHEMA_FULL } from './sqliteSchema'
import { SqliteRepository } from './sqliteRepository'

/**
 * Migration 19 — `board_items.po_user_action`, o que o usuário precisa fazer no
 * cartão "a fazer". Coluna que aceita nulo: o banco antigo ganha a coluna ao
 * reabrir, e a linha que já existia continua legível, só sem ação.
 */

const base = { projectId: 'p1', projectCwd: 'C:/GitHub/agent-code', conversationId: 'conv-1' }

async function withRepo(run: (repo: SqliteRepository, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-code-board-user-action-'))
  try {
    const repo = new SqliteRepository(dir, join(dir, 'agent-code.db'), 'device-a')
    await repo.initialize()
    try {
      await run(repo, dir)
    } finally {
      await repo.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('SQLITE_MIGRATIONS — migration 19 (board_items.po_user_action)', () => {
  it('roda uma vez (bootstrap/migração), nunca no guarda de write()', () => {
    const nineteen = SQLITE_MIGRATIONS.find((entry) => entry.version === 19)
    expect(nineteen).toMatchObject({ name: 'sqlite-v2-board-user-action', writeGuardSql: '' })
    expect(nineteen!.sql).toMatch(/ALTER TABLE board_items ADD COLUMN po_user_action TEXT/i)
    expect(SQLITE_MIGRATIONS.at(-1)?.version).toBe(19)
    expect(SQLITE_SCHEMA).not.toMatch(/po_user_action/)
    expect(SQLITE_SCHEMA_FULL).toMatch(/ADD COLUMN po_user_action/)
  })

  it('NOVA grava e lê a ação; o cartão comum continua sem o campo; o texto é limpo e cortado em 120', async () => {
    await withRepo(async (repo) => {
      const plain = await repo.createBoardPoItem({ ...base, title: 'Implementar a fase 1', status: 'completed', reason: 'feito' })
      const waiting = await repo.createBoardPoItem({
        ...base,
        title: 'Atualizar a VPS',
        status: 'pending',
        reason: 'aguardando autorização do usuário',
        userAction: '  Autorizar   a atualização\n da VPS '
      })
      const long = await repo.createBoardPoItem({ ...base, title: 'Longa', status: 'pending', reason: 'r', userAction: 'x'.repeat(300) })
      expect(plain).not.toHaveProperty('poUserAction')
      expect(waiting.poUserAction).toBe('Autorizar a atualização da VPS')
      expect(long.poUserAction).toHaveLength(120)
      const listed = await repo.listBoardItems({ projectIds: ['p1'] })
      expect(listed.find((item) => item.id === waiting.id)?.poUserAction).toBe('Autorizar a atualização da VPS')
      expect((await repo.getBoardItem(waiting.id))?.poUserAction).toBe('Autorizar a atualização da VPS')
    })
  })

  it('applyBoardPo: grava no PENDENTE, mantém no título/rebaixamento explícito, limpa ao trocar o status ou com null', async () => {
    await withRepo(async (repo) => {
      const card = await repo.createBoardPoItem({ ...base, title: 'Tela nova', status: 'in_progress', reason: 'r' })
      const justified = await repo.applyBoardPo({ id: card.id, poReason: 'fim — esperando o layout', userAction: 'Escolher o layout' })
      expect(justified.poUserAction).toBe('Escolher o layout')
      // Sem status nem ação: fica (o TITULO não mexe no que o usuário precisa fazer).
      expect((await repo.applyBoardPo({ id: card.id, poTitle: 'Criar a tela nova' })).poUserAction).toBe('Escolher o layout')
      // O fim de turno rebaixa passando a ação: fica.
      const demoted = await repo.applyBoardPo({
        id: card.id,
        poStatus: 'pending',
        poReason: 'fim — esperando o layout',
        userAction: 'Escolher o layout',
        actor: 'system'
      })
      expect(demoted.poUserAction).toBe('Escolher o layout')
      // Qualquer troca de status sem a ação (retomada, CONCLUIR, arrasto): limpa.
      const resumed = await repo.applyBoardPo({ id: card.id, poStatus: 'in_progress', poReason: 'retomou', actor: 'system' })
      expect(resumed).not.toHaveProperty('poUserAction')
      await repo.applyBoardPo({ id: card.id, poReason: 'de novo', userAction: 'Escolher o layout' })
      expect(await repo.applyBoardPo({ id: card.id, userAction: null })).not.toHaveProperty('poUserAction')
    })
  })

  it('banco antigo (parou na 18): ganha a coluna ao reabrir, e a linha de antes continua legível sem ação', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-code-board-user-action-up-'))
    try {
      const dbPath = join(dir, 'agent-code.db')
      const repo = new SqliteRepository(dir, dbPath, 'device-a')
      await repo.initialize()
      const old = await repo.createBoardPoItem({ ...base, title: 'Cartão de antes', status: 'pending', reason: 'antigo' })
      await repo.close()
      // Simula a versão anterior: sem a coluna e sem o registro da 19.
      const db = new DatabaseSync(dbPath)
      try {
        db.exec('ALTER TABLE board_items DROP COLUMN po_user_action; DELETE FROM schema_migrations WHERE version = 19;')
      } finally {
        db.close()
      }

      const reopened = new SqliteRepository(dir, dbPath, 'device-a')
      await reopened.initialize()
      const [before] = await reopened.listBoardItems({ projectIds: ['p1'] })
      expect(before).toMatchObject({ id: old.id, sourceTitle: 'Cartão de antes' })
      expect(before).not.toHaveProperty('poUserAction')
      const written = await reopened.applyBoardPo({ id: old.id, poReason: 'esperando o usuário', userAction: 'Autorizar o deploy' })
      expect(written.poUserAction).toBe('Autorizar o deploy')
      await reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
