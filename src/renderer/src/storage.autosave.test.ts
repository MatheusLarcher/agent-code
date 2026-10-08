import { describe, expect, it, vi } from 'vitest'
import type { ConversationChangeDto, RepositoryChange, VersionedConversationDto } from '@shared/ipc'
import { applyChanges } from './conversationSyncFake'
import type { Conversation } from './types'

/**
 * O tique do autosave entrega à fila do main só as conversas em `only`; fechar (sem
 * `only`) entrega todas. Cada PC é um módulo novo de storage + entrega sobre o
 * MESMO banco falso, que aqui grava na hora o que a tela entrega (a fila de
 * verdade — ritmo, conflito, diário — tem os testes dela no main).
 */

type Storage = typeof import('./storage')
type Sync = typeof import('./conversationSync')

const NOW = Date.now()
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

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
  function put(id: string, payload: Record<string, unknown>, deleted = false): void {
    const revision = (rows.get(id)?.revision ?? 0) + 1
    rows.set(id, {
      id,
      payload: clone(payload),
      revision,
      contentHash: `h${revision}`,
      createdAt: '2026-10-05T12:00:00.000Z',
      updatedAt: '2026-10-05T12:00:00.000Z',
      ...(deleted ? { deletedAt: '2026-10-05T12:00:00.000Z' } : {})
    })
  }
  return {
    put,
    row: (id: string) => rows.get(id),
    /** O que a fila do main faria com a entrega (gravando na hora). */
    apply(changes: ConversationChangeDto[]): void {
      const docs = [...rows.values()].filter((row) => !row.deletedAt).map((row) => ({ ...row.payload, id: row.id }))
      const next = applyChanges(docs, changes)
      for (const change of changes) {
        const doc = next.find((entry) => entry.id === change.id)
        if (doc) put(change.id, doc)
        else if (rows.get(change.id) && !rows.get(change.id)?.deletedAt) put(change.id, rows.get(change.id)!.payload, true)
      }
    },
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
  const sync: Sync = await import('./conversationSync')
  const delivered: ConversationChangeDto[] = []
  const api = {
    getStorageStatus: vi.fn(async () => ({ installationId })),
    loadVersionedConversations: vi.fn((query?: { ids?: string[] }) => db.load(query)),
    syncConversations: vi.fn((changes: ConversationChangeDto[]) => {
      delivered.push(...clone(changes))
      db.apply(changes)
    })
  }
  const pc = {
    storage,
    sync,
    delivered,
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

describe('entrega com only (tique do autosave)', () => {
  it('trata só os ids em only: a não alterada não é entregue, mesmo diferente do banco', async () => {
    const db = sharedDb()
    db.put('c1', chat('c1') as unknown as Record<string, unknown>)
    db.put('c2', chat('c2') as unknown as Record<string, unknown>)
    const a = await bootPc(db, 'pc-a')
    const [c1, c2] = await a.storage.loadConversations()

    const list = [{ ...c1, title: 'Editada' }, { ...c2, title: 'Fora do tique' }]
    expect(a.sync.syncConversations(list, { only: new Set(['c1']) })).toEqual({ processed: 1, sent: 1 })
    expect(a.delivered.map((d) => [d.id, d.top?.title])).toEqual([['c1', 'Editada']])

    // Fechar (sem only) compara todas e entrega a que ficou.
    expect(a.sync.syncConversations(list)).toEqual({ processed: 2, sent: 1 })
    expect(a.delivered.map((d) => [d.id, d.top?.title])).toEqual([
      ['c1', 'Editada'],
      ['c2', 'Fora do tique']
    ])
    expect(db.row('c2')?.payload.title).toBe('Fora do tique')
  })

  it('abrir o app: tudo que veio do banco passa pelo primeiro tique sem nada entregue', async () => {
    const db = sharedDb()
    db.put('c1', chat('c1') as unknown as Record<string, unknown>)
    db.put('c2', chat('c2') as unknown as Record<string, unknown>)
    const a = await bootPc(db, 'pc-a')
    const loaded = await a.storage.loadConversations()
    expect(a.sync.syncConversations(loaded, { only: new Set(loaded.map((c) => c.id)) })).toEqual({ processed: 2, sent: 0 })
    expect(db.row('c1')?.revision).toBe(1)
  })

  it('only vazio ainda apaga a conversa que saiu da lista', async () => {
    const db = sharedDb()
    db.put('c1', chat('c1') as unknown as Record<string, unknown>)
    db.put('c2', chat('c2') as unknown as Record<string, unknown>)
    const a = await bootPc(db, 'pc-a')
    const loaded = await a.storage.loadConversations()
    a.sync.syncConversations(loaded, { only: new Set() })

    expect(a.sync.syncConversations([loaded[0]], { only: new Set() })).toEqual({ processed: 0, sent: 1 })
    expect(a.delivered).toEqual([{ id: 'c2', deleted: true }])
    expect(db.row('c2')?.deletedAt).toBeDefined()
  })
})

describe('mudança recebida pelo feed (duas instalações)', () => {
  it('o A não devolve à fila o que veio do B, e continua recebendo as gravações seguintes do B', async () => {
    const db = sharedDb()
    db.put('c1', chat('c1') as unknown as Record<string, unknown>)
    const a = await bootPc(db, 'pc-a')
    let screen = await a.storage.loadConversations()
    const b = await bootPc(db, 'pc-b')
    const bScreen = await b.storage.loadConversations()

    // Abrir o A: o App marca tudo como suja e o primeiro tique compara.
    a.use()
    a.storage.markConversationsDirty(screen.map((c) => c.id))
    a.sync.syncConversations(screen, { only: new Set(screen.map((c) => c.id)) })

    // O B renomeia (rev 2).
    b.use()
    b.sync.syncConversations([{ ...bScreen[0], title: 'Renomeada no B' }])

    // O feed traz a rev 2 para o A; o objeto novo entra na tela → o App o marca e
    // ele passa pelo próximo tique, onde nada é entregue.
    a.use()
    let updates = await a.storage.loadConversationChanges([change(2, 'pc-b', 'c1')])
    expect(updates.get('c1')).toMatchObject({ title: 'Renomeada no B' })
    screen = [updates.get('c1')!]
    a.storage.markConversationsDirty(['c1'])
    a.sync.syncConversations(screen, { only: new Set(['c1']) })
    expect(a.delivered).toHaveLength(0)

    // A próxima gravação do B ainda chega ao A (a marca não ficou presa).
    b.use()
    b.sync.syncConversations([{ ...bScreen[0], title: 'De novo no B' }])
    a.use()
    updates = await a.storage.loadConversationChanges([change(3, 'pc-b', 'c1')])
    expect(updates.get('c1')).toMatchObject({ title: 'De novo no B' })
    expect(a.delivered).toHaveLength(0)
  })

  it('mudança na tela ainda não entregue: o feed não troca a conversa; entregue, volta a receber', async () => {
    const db = sharedDb()
    db.put('c1', chat('c1') as unknown as Record<string, unknown>)
    const a = await bootPc(db, 'pc-a')
    const [loaded] = await a.storage.loadConversations()
    const editada = { ...loaded, title: 'Editada' }
    a.storage.markConversationsDirty(['c1'])

    db.put('c1', { ...(chat('c1') as unknown as Record<string, unknown>), title: 'Do B' }) // rev 2
    expect((await a.storage.loadConversationChanges([change(2, 'pc-b', 'c1')])).size).toBe(0)

    a.sync.syncConversations([editada], { only: new Set(['c1']) }) // rev 3, daqui
    db.put('c1', { ...(chat('c1') as unknown as Record<string, unknown>), title: 'Do B de novo' }) // rev 4
    const updates = await a.storage.loadConversationChanges([change(4, 'pc-b', 'c1')])
    expect(updates.get('c1')).toMatchObject({ title: 'Do B de novo' })
  })
})
