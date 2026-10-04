// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secretPlaceholder, type ContextBlock } from '../../shared/contextSnapshot'
import { contextTextHash } from './contextHistoryCodec'
import { SqliteRepository } from './sqliteRepository'
import type { ContextTurnWrite } from './types'

const tempDirs: string[] = []
const opened: SqliteRepository[] = []

async function repository(): Promise<{ repo: SqliteRepository; dbPath: string }> {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-context-'))
  tempDirs.push(cache)
  const dbPath = join(cache, 'agent-code.db')
  const repo = new SqliteRepository(cache, dbPath, 'device-a')
  await repo.initialize()
  opened.push(repo)
  return { repo, dbPath }
}

function count(dbPath: string, table: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
  } finally {
    db.close()
  }
}

function block(text: string, patch: Partial<ContextBlock> = {}): ContextBlock {
  return {
    kind: 'user-request',
    label: 'Pedido',
    source: 'prompt',
    hash: contextTextHash(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    at: 1_700_000_000_000,
    text,
    ...patch
  }
}

function turn(turnId: string, blocks: ContextBlock[], patch: Partial<ContextTurnWrite> = {}): ContextTurnWrite {
  return {
    convId: 'conv-1',
    turnId,
    pc: 'PC-A',
    startedAt: 1_700_000_000_000,
    model: 'claude-opus',
    models: [],
    provider: 'claude',
    request: 'faça algo',
    memoriesSent: ['user/estilo.md'],
    complete: false,
    blocks,
    usage: null,
    secrets: [],
    ...patch
  }
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((repo) => repo.close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('SqliteRepository — histórico do contexto', () => {
  it('grava o turno e relê igual (textos descomprimidos, usage, máscaras)', async () => {
    const { repo } = await repository()
    const blocks = [
      block('pedido do usuário com acentuação — ção', { at: 1 }),
      block('catálogo de memórias\n'.repeat(200), { kind: 'memory-catalog', label: 'Memórias', at: 2 }),
      block('trecho do hook', { kind: 'docs', label: 'Docs', source: 'hook-start', hash: '', at: 3 })
    ]
    const usage = {
      detail: 'summary' as const,
      at: 5,
      totalTokens: 1200,
      maxTokens: 200_000,
      percentage: 0.6,
      categories: [{ name: 'Mensagens', tokens: 1200, kind: 'used' as const }]
    }
    const models = [
      { model: 'claude-opus-5-5', calls: 3, node: null },
      { model: 'claude-haiku-4-5', calls: 1, node: 'task-1' },
      { model: 'gpt-6.1-sol', calls: 2, node: null }
    ]
    await repo.saveContextTurn(
      turn('t1', blocks, { usage, models, secrets: [{ name: 'github', length: 12 }], complete: true })
    )

    const detail = await repo.readContextTurn('conv-1', 't1')
    expect(detail).toEqual({
      convId: 'conv-1',
      turnId: 't1',
      pc: 'PC-A',
      startedAt: 1_700_000_000_000,
      model: 'claude-opus',
      models,
      provider: 'claude',
      request: 'faça algo',
      blockCount: 3,
      totalBytes: blocks.reduce((sum, entry) => sum + Buffer.byteLength(entry.text, 'utf8'), 0),
      memoriesSent: ['user/estilo.md'],
      complete: true,
      // Hash vazio é recalculado (sha256 do texto) pelo repositório.
      blocks: blocks.map((entry) => ({ ...entry, hash: entry.hash || contextTextHash(entry.text) })),
      usage,
      secrets: [{ name: 'github', length: 12 }]
    })
    expect(await repo.readContextTurn('conv-1', 'nao-existe')).toBeNull()
  })

  it('regravar o mesmo turno substitui (início → fim do turno)', async () => {
    const { repo } = await repository()
    await repo.saveContextTurn(turn('t1', [block('a')]))
    await repo.saveContextTurn(turn('t1', [block('a'), block('b')], { complete: true }))
    const list = await repo.listContextTurns('conv-1', 10)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ turnId: 't1', blockCount: 2, complete: true })
  })

  it('lista os N mais recentes, mais novo primeiro, sem texto', async () => {
    const { repo } = await repository()
    for (let index = 0; index < 5; index += 1) {
      await repo.saveContextTurn(turn(`t${index}`, [block(`texto ${index}`)], { startedAt: 1000 + index }))
    }
    await repo.saveContextTurn(turn('outra', [block('x')], { convId: 'conv-2', startedAt: 9999 }))

    const list = await repo.listContextTurns('conv-1', 3)
    expect(list.map((entry) => entry.turnId)).toEqual(['t4', 't3', 't2'])
    expect(list[0]).toEqual({
      convId: 'conv-1',
      turnId: 't4',
      pc: 'PC-A',
      startedAt: 1004,
      model: 'claude-opus',
      models: [],
      provider: 'claude',
      request: 'faça algo',
      blockCount: 1,
      totalBytes: Buffer.byteLength('texto 4'),
      memoriesSent: ['user/estilo.md'],
      complete: false
    })
    expect(list[0]).not.toHaveProperty('blocks')
  })

  it('bloco repetido entre dois turnos não cria um segundo blob', async () => {
    const { repo, dbPath } = await repository()
    const shared = 'catálogo de skills idêntico nos dois turnos'
    await repo.saveContextTurn(turn('t1', [block(shared), block('só no t1')]))
    expect(count(dbPath, 'context_blob')).toBe(2)
    // Repetido também dentro do mesmo turno.
    await repo.saveContextTurn(turn('t2', [block(shared), block(shared), block('só no t2')]))
    expect(count(dbPath, 'context_blob')).toBe(3)
    expect(count(dbPath, 'context_turn')).toBe(2)
    expect((await repo.readContextTurn('conv-1', 't2'))!.blocks.map((entry) => entry.text)).toEqual([
      shared,
      shared,
      'só no t2'
    ])
  })

  it('apagar a conversa apaga os turnos dela (e só dela)', async () => {
    const { repo, dbPath } = await repository()
    await repo.upsertConversation({ id: 'conv-1', payload: { id: 'conv-1', title: 'um', messages: [] } })
    await repo.saveContextTurn(turn('t1', [block('a')]))
    await repo.saveContextTurn(turn('t2', [block('b')]))
    await repo.saveContextTurn(turn('t3', [block('c')], { convId: 'conv-2' }))

    const current = (await repo.loadConversations({ ids: ['conv-1'] }))[0]
    await repo.deleteConversation({ id: 'conv-1', expectedRevision: current.revision })

    expect(await repo.listContextTurns('conv-1', 10)).toEqual([])
    expect(await repo.readContextTurn('conv-1', 't1')).toBeNull()
    expect((await repo.listContextTurns('conv-2', 10)).map((entry) => entry.turnId)).toEqual(['t3'])
    expect(count(dbPath, 'context_turn')).toBe(1)
  })

  it('snapshot atrasado depois de apagar a conversa não recria turno nem blob', async () => {
    const { repo, dbPath } = await repository()
    const current = await repo.upsertConversation({ id: 'conv-1', payload: { id: 'conv-1' } })
    await repo.saveContextTurn(turn('t1', [block('início')]))
    await repo.deleteConversation({ id: current.id, expectedRevision: current.revision })
    await repo.pruneOrphanContextBlobs()
    await repo.saveContextTurn(turn('t1', [block('fim atrasado')], { complete: true }))
    await repo.saveContextTurn(turn('late-new', [block('outro atrasado')]))
    expect(await repo.listContextTurns('conv-1', 10)).toEqual([])
    expect(count(dbPath, 'context_blob')).toBe(0)
  })

  it('sobrevive a fechar e reabrir o repositório, incluindo estado vazio e erros', async () => {
    const { repo, dbPath } = await repository()
    await repo.saveContextTurn(turn('t1', [block('persistente')]))
    await repo.close()
    await expect(repo.listContextTurns('conv-1', 10)).rejects.toMatchObject({ code: 'STORAGE_OFFLINE' })
    const reopened = new SqliteRepository(join(dbPath, '..'), dbPath, 'device-a')
    await reopened.initialize()
    opened.push(reopened)
    expect((await reopened.readContextTurn('conv-1', 't1'))!.blocks[0].text).toBe('persistente')
    expect(await reopened.listContextTurns('conv-1', 0)).toEqual([])
    await reopened.saveContextTurn(turn('t1', [], { complete: true }))
    expect(await reopened.readContextTurn('conv-1', 't1')).toMatchObject({ blocks: [], blockCount: 0, complete: true })
    await expect(reopened.listContextTurns('conv-1', -1)).rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' })
  })

  it('bulk delete remove turnos na mesma escrita e libera só blobs órfãos', async () => {
    const { repo, dbPath } = await repository()
    await repo.upsertConversation({ id: 'conv-1', payload: { id: 'conv-1' } })
    await repo.upsertConversation({ id: 'conv-2', payload: { id: 'conv-2' } })
    await repo.saveContextTurn(turn('t1', [block('compartilhado'), block('só removida')]))
    await repo.saveContextTurn(turn('t2', [block('compartilhado')], { convId: 'conv-2' }))
    await repo.replaceAllConversations([{ id: 'conv-2' }])
    expect(await repo.listContextTurns('conv-1', 10)).toEqual([])
    expect(await repo.readContextTurn('conv-1', 't1')).toBeNull()
    expect((await repo.listContextTurns('conv-2', 10)).map((entry) => entry.turnId)).toEqual(['t2'])
    expect(count(dbPath, 'context_turn')).toBe(1)
    expect(await repo.pruneOrphanContextBlobs()).toBe(1)
    expect((await repo.readContextTurn('conv-2', 't2'))!.blocks[0].text).toBe('compartilhado')
    await repo.replaceAllConversations([])
    expect(await repo.pruneOrphanContextBlobs()).toBe(1)
  })

  it('deleteContextTurns apaga os turnos e devolve quantos', async () => {
    const { repo } = await repository()
    await repo.saveContextTurn(turn('t1', [block('a')]))
    await repo.saveContextTurn(turn('t2', [block('b')]))
    expect(await repo.deleteContextTurns('conv-1')).toBe(2)
    expect(await repo.deleteContextTurns('conv-1')).toBe(0)
  })

  it('a poda remove só os blobs órfãos', async () => {
    const { repo, dbPath } = await repository()
    await repo.saveContextTurn(turn('t1', [block('compartilhado'), block('só do t1')]))
    await repo.saveContextTurn(turn('t2', [block('compartilhado'), block('só do t2')], { convId: 'conv-2' }))
    expect(await repo.pruneOrphanContextBlobs()).toBe(0)
    expect(count(dbPath, 'context_blob')).toBe(3)

    await repo.deleteContextTurns('conv-1')
    expect(await repo.pruneOrphanContextBlobs()).toBe(1)
    expect(count(dbPath, 'context_blob')).toBe(2)
    expect((await repo.readContextTurn('conv-2', 't2'))!.blocks.map((entry) => entry.text)).toEqual([
      'compartilhado',
      'só do t2'
    ])

    // Regravar um turno com outro conteúdo deixa o texto antigo órfão.
    await repo.saveContextTurn(turn('t2', [block('novo')], { convId: 'conv-2' }))
    expect(await repo.pruneOrphanContextBlobs()).toBe(2)
    expect(count(dbPath, 'context_blob')).toBe(1)
  })

  it('o valor da senha mascarada nunca chega ao arquivo .db', async () => {
    const { repo, dbPath } = await repository()
    const secretValue = 'hunter2-SENHA-DE-TESTE-9f3a'
    const masked = `Use o token ${secretPlaceholder('github')} para o push.`
    await repo.saveContextTurn(
      turn('t1', [block(masked, { kind: 'system-append', label: 'Sistema', source: 'system' })], {
        secrets: [{ name: 'github', length: secretValue.length }],
        complete: true
      })
    )

    const bytes = await readFile(dbPath)
    expect(bytes.includes(Buffer.from(secretValue, 'utf8'))).toBe(false)
    expect(bytes.includes(Buffer.from(secretValue, 'utf16le'))).toBe(false)
    const detail = await repo.readContextTurn('conv-1', 't1')
    expect(detail!.blocks[0].text).toBe(masked)
    expect(detail!.secrets).toEqual([{ name: 'github', length: secretValue.length }])
  })

  it('modelos inválidos são descartados e linha sem modelos válidos volta []', async () => {
    const { repo, dbPath } = await repository()
    const junk = [
      { model: 'claude-opus-5-5', calls: 1, node: null },
      { model: '', calls: 1, node: null },
      { model: 'x', calls: 0, node: null },
      { model: 'y', calls: 1, node: '' },
      'lixo'
    ] as unknown as ContextTurnWrite['models']
    await repo.saveContextTurn(turn('t1', [block('a')], { models: junk }))
    expect((await repo.readContextTurn('conv-1', 't1'))!.models).toEqual([{ model: 'claude-opus-5-5', calls: 1, node: null }])
    await repo.close()
    const db = new DatabaseSync(dbPath)
    try {
      db.prepare("UPDATE context_turn SET models_json = 'não é json'").run()
    } finally {
      db.close()
    }
    const reopened = new SqliteRepository(join(dbPath, '..'), dbPath, 'device-a')
    await reopened.initialize()
    opened.push(reopened)
    expect((await reopened.listContextTurns('conv-1', 10))[0].models).toEqual([])
  })

  it('banco na migração 13 sobe para a 14: turno antigo ganha models []', async () => {
    const { repo, dbPath } = await repository()
    await repo.saveContextTurn(turn('antigo', [block('a')], { models: [{ model: 'm', calls: 1, node: null }] }))
    await repo.close()
    // Volta o arquivo ao estado de quem só tinha a migração 13.
    const db = new DatabaseSync(dbPath)
    try {
      db.exec('ALTER TABLE context_turn DROP COLUMN models_json')
      db.prepare('DELETE FROM schema_migrations WHERE version = 14').run()
    } finally {
      db.close()
    }
    const reopened = new SqliteRepository(join(dbPath, '..'), dbPath, 'device-a')
    await reopened.initialize()
    opened.push(reopened)
    expect((await reopened.readContextTurn('conv-1', 'antigo'))!.models).toEqual([])
    await reopened.saveContextTurn(turn('novo', [block('b')], { models: [{ model: 'gpt-6.1-sol', calls: 2, node: null }] }))
    expect((await reopened.readContextTurn('conv-1', 'novo'))!.models).toEqual([{ model: 'gpt-6.1-sol', calls: 2, node: null }])
  })

  it('recusa escrita sem ids ou com provedor desconhecido', async () => {
    const { repo } = await repository()
    await expect(repo.saveContextTurn(turn('', [block('a')]))).rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' })
    await expect(
      repo.saveContextTurn(turn('t1', [block('a')], { provider: 'outro' as ContextTurnWrite['provider'] }))
    ).rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' })
    expect(await repo.listContextTurns('conv-1', 10)).toEqual([])
  })
})
