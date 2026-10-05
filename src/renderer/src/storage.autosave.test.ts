import { describe, expect, it, vi } from 'vitest'
import type { RepositoryChange, VersionedConversationDto } from '@shared/ipc'
import type { Conversation } from './types'

/**
 * O tique do autosave só trata (limpa + compara + grava) as conversas em `only`;
 * fechar e reconexão (sem `only`) continuam comparando todas. Cada PC é um módulo
 * novo de storage sobre o MESMO banco falso — e o banco devolve o payload com as
 * chaves na ordem do JSONB, para provar que a comparação estável continua valendo.
 */

type Storage = typeof import('./storage')
type Upsert = { id: string; payload: Record<string, unknown>; expectedRevision?: number }

const NOW = Date.now()
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** A ordem que o PostgreSQL devolve num `jsonb`: comprimento da chave, depois bytes. */
function jsonbOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbOrder)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const keys = Object.keys(source).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
  for (const key of keys) out[key] = jsonbOrder(source[key])
  return out
}

function chat(id: string, title = 'Chat'): Conversation {
  return {
    id,
    title,
    cwd: 'C:/proj',
    model: 'claude-opus-5-5',
    sdkSessionId: null,
    messages: [{ kind: 'user', id: `${id}-m1`, text: 'oi' }],
    tokens: { context: 0, output: 0, cost: 0 },
    createdAt: NOW,
    updatedAt: NOW
  }
}

function sharedDb() {
  const rows = new Map<string, VersionedConversationDto>()
  function put(id: string, payload: Record<string, unknown>, deleted = false): VersionedConversationDto {
    const revision = (rows.get(id)?.revision ?? 0) + 1
    const row: VersionedConversationDto = {
      id,
      payload: jsonbOrder(clone(payload)) as Record<string, unknown>,
      revision,
      contentHash: `h${revision}`,
      createdAt: '2026-10-05T12:00:00.000Z',
      updatedAt: '2026-10-05T12:00:00.000Z',
      ...(deleted ? { deletedAt: '2026-10-05T12:00:00.000Z' } : {})
    }
    rows.set(id, row)
    return clone(row)
  }
  return {
    put,
    row: (id: string) => rows.get(id),
    async load(query?: { ids?: string[] }): Promise<VersionedConversationDto[]> {
      return [...rows.values()]
        .filter((row) => (query?.ids ? query.ids.includes(row.id) : !row.deletedAt))
        .map(clone)
    }
  }
}
type Db = ReturnType<typeof sharedDb>

async function bootPc(db: Db, installationId: string) {
  vi.resetModules()
  const storage: Storage = await import('./storage')
  const upserts: Upsert[] = []
  const deletes: string[] = []
  const api = {
    getStorageStatus: vi.fn(async () => ({ installationId })),
    loadVersionedConversations: vi.fn((query?: { ids?: string[] }) => db.load(query)),
    upsertConversation: vi.fn(async (input: Upsert) => {
      upserts.push(clone(input))
      return db.put(input.id, input.payload)
    }),
    deleteConversation: vi.fn(async (input: { id: string }) => {
      deletes.push(input.id)
      return db.put(input.id, db.row(input.id)!.payload, true)
    })
  }
  const pc = {
    storage,
    upserts,
    deletes,
    use(): void {
      Object.defineProperty(window, 'api', { configurable: true, value: api })
    }
  }
  pc.use()
  return pc
}

const change = (revision: number, installationId: string, entityId: string): RepositoryChange => ({
  changeId: String(revision),
  entity: 'conversation',
  entityId,
  revision,
  installationId
})

describe('saveConversations com only (tique do autosave)', () => {
  it('trata só os ids em only: a não alterada não é processada nem gravada, mesmo diferente do banco', async () => {
    const db = sharedDb()
    db.put('c1', chat('c1') as unknown as Record<string, unknown>)
    db.put('c2', chat('c2') as unknown as Record<string, unknown>)
    const a = await bootPc(db, 'pc-a')
    const [c1, c2] = await a.storage.loadConversations()

    // c2 também difere do banco, mas não está em only: este tique não encosta nela.
    const list = [{ ...c1, title: 'Editada' }, { ...c2, title: 'Fora do tique' }]
    const stats = await a.storage.saveConversations(list, { only: new Set(['c1']) })

    expect(a.upserts.map((u) => [u.id, u.payload.title])).toEqual([['c1', 'Editada']])
    expect(stats.processed).toBe(1)
    expect(stats.bytes).toBeGreaterThan(0)

    // Fechar/reconexão (sem only) continua comparando todas e grava a que ficou.
    const all = await a.storage.saveConversations(list)
    expect(all.processed).toBe(2)
    expect(all.bytes).toBeGreaterThan(stats.bytes)
    expect(a.upserts.map((u) => [u.id, u.payload.title])).toEqual([
      ['c1', 'Editada'],
      ['c2', 'Fora do tique']
    ])
  })

  it('a comparação estável continua: conversa em only igual ao banco (chaves na ordem do JSONB) não é regravada', async () => {
    const db = sharedDb()
    db.put('c1', chat('c1') as unknown as Record<string, unknown>)
    const a = await bootPc(db, 'pc-a')
    const loaded = await a.storage.loadConversations()

    // Abrir o app: a hidratação cria objetos novos, todos entram uma vez no tique.
    const stats = await a.storage.saveConversations(loaded, { only: new Set(loaded.map((c) => c.id)) })
    expect(stats.processed).toBe(1)
    expect(a.upserts).toHaveLength(0)

    const editada = { ...loaded[0], title: 'Editada' }
    await a.storage.saveConversations([editada], { only: new Set(['c1']) })
    await a.storage.saveConversations([editada], { only: new Set(['c1']) })
    expect(a.upserts).toHaveLength(1)
  })

  it('only vazio ainda apaga a conversa que saiu da lista (detecção de apagadas inalterada)', async () => {
    const db = sharedDb()
    db.put('c1', chat('c1') as unknown as Record<string, unknown>)
    db.put('c2', chat('c2') as unknown as Record<string, unknown>)
    const a = await bootPc(db, 'pc-a')
    const [c1] = await a.storage.loadConversations()

    const stats = await a.storage.saveConversations([c1], { only: new Set() })
    expect(stats).toEqual({ processed: 0, bytes: 0 })
    expect(a.deletes).toEqual(['c2'])
    expect(a.upserts).toHaveLength(0)
  })
})

describe('mudança recebida pelo feed (duas instalações)', () => {
  it('o A não regrava o que veio do B, e continua recebendo as gravações seguintes do B', async () => {
    const db = sharedDb()
    db.put('c1', chat('c1') as unknown as Record<string, unknown>)
    const a = await bootPc(db, 'pc-a')
    let screen = await a.storage.loadConversations()
    const b = await bootPc(db, 'pc-b')
    const [bLoaded] = await b.storage.loadConversations()

    // Abrir o A: o App marca tudo como não salvo e o primeiro tique compara.
    a.use()
    a.storage.markConversationsDirty(screen.map((c) => c.id))
    await a.storage.saveConversations(screen, { only: new Set(screen.map((c) => c.id)) })

    // O B renomeia e grava (rev 2).
    b.use()
    await b.storage.saveConversations([{ ...bLoaded, title: 'Renomeada no B' }])

    // O feed traz a rev 2 para o A; o objeto novo entra no estado → o App o marca
    // e ele vai no próximo tique, onde é igual ao confirmado: nada é gravado.
    a.use()
    let updates = await a.storage.loadConversationChanges([change(2, 'pc-b', 'c1')])
    expect(updates.get('c1')).toMatchObject({ title: 'Renomeada no B' })
    screen = [updates.get('c1')!]
    a.storage.markConversationsDirty(['c1'])
    const stats = await a.storage.saveConversations(screen, { only: new Set(['c1']) })
    expect(stats.processed).toBe(1)
    expect(a.upserts).toHaveLength(0)

    // A próxima gravação do B ainda chega ao A (a marca não ficou presa).
    b.use()
    await b.storage.saveConversations([{ ...bLoaded, title: 'De novo no B' }])
    a.use()
    updates = await a.storage.loadConversationChanges([change(3, 'pc-b', 'c1')])
    expect(updates.get('c1')).toMatchObject({ title: 'De novo no B' })
    expect(a.upserts).toHaveLength(0)
  })

  it('com escrita na fila, voltar ao conteúdo confirmado grava de novo: o banco termina com o que está na tela', async () => {
    const db = sharedDb()
    db.put('c1', chat('c1') as unknown as Record<string, unknown>)
    const a = await bootPc(db, 'pc-a')
    const [loaded] = await a.storage.loadConversations()

    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const api = (window as unknown as { api: { upsertConversation: ReturnType<typeof vi.fn> } }).api
    const store = api.upsertConversation.getMockImplementation() as (input: Upsert) => Promise<VersionedConversationDto>
    api.upsertConversation.mockImplementationOnce(async (input: Upsert) => {
      await gate
      return store(input)
    })
    const first = a.storage.saveConversations([{ ...loaded, title: 'Rascunho' }], { only: new Set(['c1']) })
    const second = a.storage.saveConversations([loaded], { only: new Set(['c1']) })
    release()
    await Promise.all([first, second])

    expect(a.upserts.map((u) => u.payload.title)).toEqual(['Rascunho', 'Chat'])
    expect(db.row('c1')?.payload.title).toBe('Chat')
  })

  it('com escrita na fila, a conversa igual continua marcada (o feed não a troca no meio da gravação)', async () => {
    const db = sharedDb()
    db.put('c1', chat('c1') as unknown as Record<string, unknown>)
    const a = await bootPc(db, 'pc-a')
    const [loaded] = await a.storage.loadConversations()
    const editada = { ...loaded, title: 'Editada' }

    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const api = (window as unknown as { api: { upsertConversation: ReturnType<typeof vi.fn> } }).api
    const store = api.upsertConversation.getMockImplementation() as (input: Upsert) => Promise<VersionedConversationDto>
    api.upsertConversation.mockImplementationOnce(async (input: Upsert) => {
      await gate
      return store(input)
    })
    const first = a.storage.saveConversations([editada], { only: new Set(['c1']) })
    // Volta ao conteúdo confirmado com a escrita ainda na fila: NÃO limpa a marca.
    const second = a.storage.saveConversations([loaded], { only: new Set(['c1']) })
    db.put('c1', { ...(chat('c1') as unknown as Record<string, unknown>), title: 'Do B' })
    const updates = await a.storage.loadConversationChanges([change(9, 'pc-b', 'c1')])
    expect(updates.size).toBe(0)
    release()
    await Promise.all([first, second])
  })
})
