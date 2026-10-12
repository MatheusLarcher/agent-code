// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLITE_MIGRATIONS, SQLITE_SCHEMA, SQLITE_SCHEMA_FULL } from './sqliteSchema'
import { SqliteRepository } from './sqliteRepository'
import type { BoardSourceItem } from './types'

/**
 * Migration 20 — `board_items.po_reply_kind`, o controle do cartão ("Pode fazer"
 * ou responder). Aceita nulo, só vale junto de `po_user_action` e some com ela.
 */

const base = { projectId: 'p1', projectCwd: 'C:/GitHub/agent-code', conversationId: 'conv-1' }

async function withRepo(run: (repo: SqliteRepository) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-code-board-reply-kind-'))
  try {
    const repo = new SqliteRepository(dir, join(dir, 'agent-code.db'), 'device-a')
    await repo.initialize()
    try {
      await run(repo)
    } finally {
      await repo.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function source(sourceId: string, title: string, status: BoardSourceItem['status']): BoardSourceItem {
  return { sourceId, title, status, activeForm: null, seq: 0 }
}

describe('SQLITE_MIGRATIONS — migration 20 (board_items.po_reply_kind)', () => {
  it('roda uma vez (bootstrap/migração), nunca no guarda de write()', () => {
    const twenty = SQLITE_MIGRATIONS.find((entry) => entry.version === 20)
    expect(twenty).toMatchObject({ name: 'sqlite-v2-board-reply-kind', writeGuardSql: '' })
    expect(twenty!.sql).toMatch(/ALTER TABLE board_items ADD COLUMN po_reply_kind TEXT/i)
    expect(SQLITE_SCHEMA).not.toMatch(/po_reply_kind/)
    expect(SQLITE_SCHEMA_FULL).toMatch(/ADD COLUMN po_reply_kind/)
  })

  it('NOVA grava e lê o controle; sem ação não há controle; valor inválido não é gravado', async () => {
    await withRepo(async (repo) => {
      const waiting = await repo.createBoardPoItem({
        ...base,
        title: 'Atualizar a VPS',
        status: 'pending',
        reason: 'aguardando autorização do usuário',
        userAction: 'Autorizar a atualização da VPS',
        replyKind: 'authorize'
      })
      const noAction = await repo.createBoardPoItem({ ...base, title: 'Sem ação', status: 'pending', reason: 'r', replyKind: 'answer' })
      const bad = await repo.createBoardPoItem({
        ...base,
        title: 'Inválido',
        status: 'pending',
        reason: 'r',
        userAction: 'Escolher',
        replyKind: 'sim' as never
      })
      expect(waiting.poReplyKind).toBe('authorize')
      expect(noAction).not.toHaveProperty('poReplyKind')
      expect(bad).toMatchObject({ poUserAction: 'Escolher' })
      expect(bad).not.toHaveProperty('poReplyKind')
      const listed = await repo.listBoardItems({ projectIds: ['p1'] })
      expect(listed.find((item) => item.id === waiting.id)?.poReplyKind).toBe('authorize')
      expect((await repo.getBoardItem(waiting.id))?.poReplyKind).toBe('authorize')
    })
  })

  it('applyBoardPo: grava junto da ação, mantém sem mexer nela, limpa com ação nova, troca de status ou null', async () => {
    await withRepo(async (repo) => {
      const card = await repo.createBoardPoItem({ ...base, title: 'Tela nova', status: 'in_progress', reason: 'r' })
      const justified = await repo.applyBoardPo({
        id: card.id,
        poReason: 'fim — esperando o layout',
        userAction: 'Escolher o layout',
        replyKind: 'answer'
      })
      expect(justified).toMatchObject({ poUserAction: 'Escolher o layout', poReplyKind: 'answer' })
      expect((await repo.applyBoardPo({ id: card.id, poTitle: 'Criar a tela nova' })).poReplyKind).toBe('answer')
      // O fim de turno rebaixa passando ação e controle: ficam.
      const demoted = await repo.applyBoardPo({
        id: card.id,
        poStatus: 'pending',
        poReason: 'fim — esperando o layout',
        userAction: 'Escolher o layout',
        replyKind: 'answer',
        actor: 'system'
      })
      expect(demoted.poReplyKind).toBe('answer')
      // Ação nova sem controle: limpa só o controle.
      const swapped = await repo.applyBoardPo({ id: card.id, poReason: 'outra', userAction: 'Testar no celular' })
      expect(swapped).toMatchObject({ poUserAction: 'Testar no celular' })
      expect(swapped).not.toHaveProperty('poReplyKind')
      // Troca de status sem a ação: some tudo.
      await repo.applyBoardPo({ id: card.id, poReason: 'de novo', userAction: 'Autorizar', replyKind: 'authorize' })
      const resumed = await repo.applyBoardPo({ id: card.id, poStatus: 'in_progress', poReason: 'retomou', actor: 'system' })
      expect(resumed).not.toHaveProperty('poReplyKind')
      // A ação que some leva o controle.
      await repo.applyBoardPo({ id: card.id, poReason: 'de novo', userAction: 'Autorizar', replyKind: 'authorize' })
      const cleared = await repo.applyBoardPo({ id: card.id, userAction: null })
      expect(cleared).not.toHaveProperty('poUserAction')
      expect(cleared).not.toHaveProperty('poReplyKind')
    })
  })

  it('sync que solta o po_status também solta o controle', async () => {
    await withRepo(async (repo) => {
      const sync = (status: BoardSourceItem['status']) =>
        repo.syncBoardItems({ ...base, items: [source('1', 'uma', status)] })
      const [card] = await sync('in_progress')
      await repo.applyBoardPo({ id: card.id, poStatus: 'pending', poReason: 'esperando', userAction: 'Autorizar', replyKind: 'authorize' })
      expect((await repo.getBoardItem(card.id))?.poReplyKind).toBe('authorize')
      const [after] = await sync('completed')
      expect(after).not.toHaveProperty('poUserAction')
      expect(after).not.toHaveProperty('poReplyKind')
    })
  })

  it('banco sem a coluna (parou na 19): ganha a coluna ao reabrir e continua legível', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-code-board-reply-kind-up-'))
    try {
      const dbPath = join(dir, 'agent-code.db')
      const repo = new SqliteRepository(dir, dbPath, 'device-a')
      await repo.initialize()
      const old = await repo.createBoardPoItem({ ...base, title: 'Antes', status: 'pending', reason: 'r', userAction: 'Autorizar o deploy' })
      await repo.close()
      const db = new DatabaseSync(dbPath)
      try {
        db.exec('ALTER TABLE board_items DROP COLUMN po_reply_kind; DELETE FROM schema_migrations WHERE version = 20;')
      } finally {
        db.close()
      }

      const reopened = new SqliteRepository(dir, dbPath, 'device-a')
      await reopened.initialize()
      const [before] = await reopened.listBoardItems({ projectIds: ['p1'] })
      expect(before).toMatchObject({ id: old.id, poUserAction: 'Autorizar o deploy' })
      expect(before).not.toHaveProperty('poReplyKind')
      const written = await reopened.applyBoardPo({ id: old.id, poReason: 'esperando', userAction: 'Autorizar o deploy', replyKind: 'authorize' })
      expect(written.poReplyKind).toBe('authorize')
      await reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
