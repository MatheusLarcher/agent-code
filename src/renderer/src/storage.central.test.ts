import { describe, expect, it, vi } from 'vitest'
import { CENTRAL_ID, type CentralEntry } from '@shared/central'
import type { RepositoryChange, VersionedConversationDto } from '@shared/ipc'
import type { Conversation } from './types'

/**
 * A Central é UMA linha que os dois PCs gravam (ver central/centralMerge.ts). A
 * gravação mesclada por dono (com rebase no conflito) é da fila do main — testada
 * em conversationWriteQueue.central.test.ts. Aqui, a tela: o feed e o remoto que a
 * fila relê chegam mesclados por dono, nunca trocando a Central inteira. Cada PC é
 * um módulo novo de storage sobre o MESMO banco falso.
 */

type Storage = typeof import('./storage')

const NOW = Date.now()
const A = 'pc-a'
const B = 'pc-b'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function req(id: string, ts: number, device: string): CentralEntry {
  return { kind: 'request', id, ts, text: id, state: 'delivered', device } as CentralEntry
}

function central(entries: CentralEntry[]): Conversation {
  return {
    id: CENTRAL_ID,
    title: 'Central',
    titleSource: 'user',
    cwd: '',
    mode: 'central',
    model: 'claude-opus-5-5',
    sdkSessionId: null,
    messages: [],
    tokens: { context: 0, output: 0, cost: 0 },
    createdAt: NOW,
    updatedAt: NOW,
    central: { entries }
  }
}

const entryIds = (payload: unknown): string[] =>
  ((payload as { central?: { entries?: { id: string }[] } } | null | undefined)?.central?.entries ?? []).map((e) => e.id)

function change(revision: number, installationId: string, entityId = CENTRAL_ID): RepositoryChange {
  return { changeId: String(revision), entity: 'conversation', entityId, revision, installationId }
}

function sharedDb() {
  const rows = new Map<string, VersionedConversationDto>()
  function put(id: string, payload: Record<string, unknown>): VersionedConversationDto {
    const revision = (rows.get(id)?.revision ?? 0) + 1
    const row = { id, payload: clone(payload), revision, contentHash: `h${revision}`, createdAt: '2026-10-02T12:00:00.000Z', updatedAt: '2026-10-02T12:00:00.000Z' }
    rows.set(id, row)
    return clone(row)
  }
  return {
    put,
    /** Um PC gravou a Central (a revisão anda). */
    write: (entries: CentralEntry[]) => put(CENTRAL_ID, central(entries) as unknown as Record<string, unknown>),
    async load(query?: { ids?: string[] }): Promise<VersionedConversationDto[]> {
      return [...rows.values()].filter((row) => !query?.ids || query.ids.includes(row.id)).map(clone)
    }
  }
}
type Db = ReturnType<typeof sharedDb>

/** Um PC: storage nova (vi.resetModules), a api dele sobre o banco e a tela (a Central). */
async function bootPc(db: Db, installationId: string) {
  vi.resetModules()
  const storage: Storage = await import('./storage')
  const api = {
    getStorageStatus: vi.fn(async () => ({ installationId })),
    loadVersionedConversations: vi.fn((query?: { ids?: string[] }) => db.load(query)),
    syncConversations: vi.fn()
  }
  const pc = {
    storage,
    api,
    screen: undefined as Conversation | undefined,
    updater: vi.fn((fn: (local: Conversation) => Conversation) => {
      if (pc.screen) pc.screen = fn(pc.screen)
    }),
    use(): void {
      Object.defineProperty(window, 'api', { configurable: true, value: api })
    },
    add(entry: CentralEntry): void {
      pc.screen = { ...pc.screen!, central: { entries: [...(pc.screen!.central?.entries ?? []), entry] } }
    },
    ids: (): string[] => entryIds(pc.screen)
  }
  pc.use()
  return pc
}
type Pc = Awaited<ReturnType<typeof bootPc>>

/** Abre a Central como o boot dela: leitura por id. */
async function openCentral(pc: Pc): Promise<void> {
  pc.use()
  const [loaded] = await pc.storage.loadConversationsByIds([CENTRAL_ID])
  pc.screen = loaded
}

describe('Central com atualizador: feed de mudanças', () => {
  it('suja ou limpa, é mesclada pelo atualizador e fica fora do resultado', async () => {
    const db = sharedDb()
    db.write([req('a1', 1, A)])
    const a = await bootPc(db, A)
    await openCentral(a)
    a.storage.registerCentralUpdater(a.updater)

    db.write([req('a1', 1, A), req('b1', 2, B)])
    let updates = await a.storage.loadConversationChanges([change(2, B)])
    expect(updates.has(CENTRAL_ID)).toBe(false)
    expect(a.ids()).toEqual(['a1', 'b1'])

    // Suja: entrada daqui ainda não entregue à fila.
    a.add(req('a2', 3, A))
    a.storage.markConversationsDirty([CENTRAL_ID])
    db.write([req('a1', 1, A), req('b1', 2, B), req('b2', 4, B)])
    updates = await a.storage.loadConversationChanges([change(3, B)])
    expect(updates.size).toBe(0)
    expect(a.ids()).toEqual(['a1', 'b1', 'a2', 'b2'])
    expect(a.updater).toHaveBeenCalledTimes(2)
  })

  it('leitura do feed que volta fora de ordem não tira da tela o que o outro PC já tinha', async () => {
    const db = sharedDb()
    db.write([req('a1', 1, A)])
    const a = await bootPc(db, A)
    await openCentral(a)
    a.storage.registerCentralUpdater(a.updater)
    await a.storage.loadConversationChanges([]) // guarda o installationId

    const rev2 = db.write([req('a1', 1, A), req('b1', 2, B)])
    db.write([req('a1', 1, A), req('b1', 2, B), req('b2', 4, B)])
    let late!: () => void
    a.api.loadVersionedConversations.mockImplementationOnce(
      () => new Promise<VersionedConversationDto[]>((resolve) => (late = () => resolve([rev2])))
    )
    const first = a.storage.loadConversationChanges([change(2, B)])
    await a.storage.loadConversationChanges([change(3, B)])
    expect(a.ids()).toEqual(['a1', 'b1', 'b2'])
    late()
    await first

    expect(a.ids()).toEqual(['a1', 'b1', 'b2'])
    expect(a.updater).toHaveBeenCalledTimes(1)
  })

  it('Central sumida do banco não sai da tela (há UMA Central, a próxima gravação a refaz)', async () => {
    const db = sharedDb()
    const a = await bootPc(db, A)
    a.storage.registerCentralUpdater(a.updater)
    a.screen = central([req('a1', 1, A)])

    const updates = await a.storage.loadConversationChanges([change(9, B)])
    expect(updates.size).toBe(0)
    expect(a.updater).not.toHaveBeenCalled()
  })
})

describe('Central: o remoto que a fila do main releu num conflito', () => {
  it('a tela ganha as entradas do outro PC, mescladas por dono', async () => {
    const db = sharedDb()
    db.write([req('a1', 1, A)])
    const a = await bootPc(db, A)
    await openCentral(a)
    a.storage.registerCentralUpdater(a.updater)
    a.add(req('a2', 3, A))

    await a.storage.mergeCentralRemote(db.write([req('a1', 1, A), req('b1', 2, B)]))
    expect(a.ids()).toEqual(['a1', 'b1', 'a2'])
  })

  it('um remoto mais velho que o já mostrado não volta a tela (nem pelo feed depois)', async () => {
    const db = sharedDb()
    db.write([req('a1', 1, A)])
    const a = await bootPc(db, A)
    await openCentral(a)
    a.storage.registerCentralUpdater(a.updater)

    const rev2 = db.write([req('a1', 1, A), req('b1', 2, B)])
    await a.storage.mergeCentralRemote(db.write([req('a1', 1, A), req('b1', 2, B), req('b2', 4, B)]))
    await a.storage.mergeCentralRemote(rev2)
    await a.storage.loadConversationChanges([change(2, B)])
    expect(a.ids()).toEqual(['a1', 'b1', 'b2'])
    expect(a.updater).toHaveBeenCalledTimes(1)
  })
})

describe('Central sem atualizador registrado: como as outras conversas', () => {
  it('feed: a limpa volta inteira no resultado; a suja é pulada', async () => {
    const db = sharedDb()
    db.write([req('a1', 1, A)])
    const a = await bootPc(db, A)
    await openCentral(a)

    db.write([req('a1', 1, A), req('b1', 2, B)])
    const updates = await a.storage.loadConversationChanges([change(2, B)])
    expect(entryIds(updates.get(CENTRAL_ID))).toEqual(['a1', 'b1'])

    a.storage.markConversationsDirty([CENTRAL_ID])
    db.write([req('b9', 9, B)])
    expect((await a.storage.loadConversationChanges([change(3, B)])).size).toBe(0)
  })

  it('registrar e depois desregistrar (null) volta a esse comportamento', async () => {
    const db = sharedDb()
    db.write([req('a1', 1, A)])
    const a = await bootPc(db, A)
    await openCentral(a)
    a.storage.registerCentralUpdater(a.updater)
    a.storage.registerCentralUpdater(null)

    db.write([req('a1', 1, A), req('b1', 2, B)])
    const updates = await a.storage.loadConversationChanges([change(2, B)])
    expect(entryIds(updates.get(CENTRAL_ID))).toEqual(['a1', 'b1'])
    expect(a.updater).not.toHaveBeenCalled()
  })
})

describe('outras conversas não mudam, mesmo com o atualizador da Central registrado', () => {
  const chat = { id: 'c1', title: 'Chat', cwd: '', messages: [], createdAt: NOW, updatedAt: NOW }

  it('feed troca a limpa e pula a suja; o atualizador nunca é chamado', async () => {
    const db = sharedDb()
    db.put('c1', chat)
    const a = await bootPc(db, A)
    await a.storage.loadConversationsByIds(['c1'])
    a.storage.registerCentralUpdater(a.updater)

    db.put('c1', { ...chat, title: 'De novo no B' }) // rev 2
    const updates = await a.storage.loadConversationChanges([change(2, B, 'c1')])
    expect(updates.get('c1')).toMatchObject({ title: 'De novo no B' })

    a.storage.markConversationsDirty(['c1'])
    db.put('c1', { ...chat, title: 'Mais uma no B' }) // rev 3
    expect((await a.storage.loadConversationChanges([change(3, B, 'c1')])).size).toBe(0)
    expect(a.updater).not.toHaveBeenCalled()
  })
})
