import { describe, expect, it, vi } from 'vitest'
import { CENTRAL_ID, type CentralEntry } from '@shared/central'
import type { RepositoryChange, VersionedConversationDto } from '@shared/ipc'
import type { Conversation } from './types'

/**
 * A Central é UMA linha que os dois PCs gravam (ver central/centralMerge.ts). Cada
 * PC aqui é um módulo novo de storage (estado próprio: revisões, fila, sujos) sobre
 * o MESMO banco falso, com o CAS do repositório — e a tela dele é a Central que o
 * atualizador registrado recebe.
 */

type Storage = typeof import('./storage')
type Upsert = { id: string; payload: Record<string, unknown>; expectedRevision?: number }

const NOW = Date.now()
const A = 'pc-a'
const B = 'pc-b'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function conflict(): Error {
  const error = new Error('[agent-code-storage-error:REVISION_CONFLICT:fatal] A conversa foi alterada por outra gravação.')
  error.name = 'StorageError'
  return error
}

// `device` chega ao tipo compartilhado pela Tarefa 5: até lá, entra por cast.
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

/** O banco compartilhado, com o CAS do repositório (assertRevision do PostgreSQL). */
function sharedDb() {
  const rows = new Map<string, VersionedConversationDto>()
  function put(id: string, payload: Record<string, unknown>): VersionedConversationDto {
    const revision = (rows.get(id)?.revision ?? 0) + 1
    const row = {
      id,
      payload: clone(payload),
      revision,
      contentHash: `h${revision}`,
      createdAt: '2026-10-02T12:00:00.000Z',
      updatedAt: '2026-10-02T12:00:00.000Z'
    }
    rows.set(id, row)
    return clone(row)
  }
  return {
    put,
    row: (id = CENTRAL_ID) => rows.get(id),
    /** O outro PC gravou a Central (a revisão anda). */
    remoteWrite: (entries: CentralEntry[]) => put(CENTRAL_ID, central(entries) as unknown as Record<string, unknown>),
    async upsert(input: Upsert): Promise<VersionedConversationDto> {
      const current = rows.get(input.id)
      const expected = input.expectedRevision
      if (current ? expected !== current.revision : expected !== undefined && expected !== 0) throw conflict()
      return put(input.id, input.payload)
    },
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
  const upserts: Upsert[] = []
  let gate: Promise<void> | null = null
  const api = {
    getStorageStatus: vi.fn(async () => ({ installationId })),
    loadVersionedConversations: vi.fn((query?: { ids?: string[] }) => db.load(query)),
    upsertConversation: vi.fn(async (input: Upsert) => {
      upserts.push(clone(input))
      if (gate) await gate
      return db.upsert(input)
    })
  }
  const pc = {
    storage,
    api,
    upserts,
    screen: undefined as Conversation | undefined,
    updater: vi.fn((fn: (local: Conversation) => Conversation) => {
      if (pc.screen) pc.screen = fn(pc.screen)
    }),
    /** Daqui em diante, `window.api` é a deste PC. */
    use(): void {
      Object.defineProperty(window, 'api', { configurable: true, value: api })
    },
    /** A próxima gravação fica "na rede" (antes de chegar ao banco) até soltar. */
    hold(): () => void {
      let release!: () => void
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null
          resolve()
        }
      })
      return release
    },
    /** Logo depois de cada releitura daqui, o outro PC grava (uma por releitura): a tentativa seguinte perde o CAS. */
    afterRereads(...writes: Array<() => unknown>): void {
      for (const write of writes) {
        api.loadVersionedConversations.mockImplementationOnce(async (query?: { ids?: string[] }) => {
          const rows = await db.load(query)
          write()
          return rows
        })
      }
    },
    add(entry: CentralEntry): void {
      pc.screen = { ...pc.screen!, central: { entries: [...(pc.screen!.central?.entries ?? []), entry] } }
    },
    ids: (): string[] => entryIds(pc.screen),
    revisions: (): Array<number | undefined> => upserts.map((u) => u.expectedRevision)
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

describe('Central com atualizador: conflito de revisão', () => {
  it('a nova tentativa grava a Central mesclada por dono e a tela ganha as entradas do outro PC', async () => {
    const db = sharedDb()
    db.remoteWrite([req('a1', 1, A)])
    const a = await bootPc(db, A)
    await openCentral(a)
    a.storage.registerCentralUpdater(a.updater)
    db.remoteWrite([req('a1', 1, A), req('b1', 2, B)]) // o B grava no meio (rev 2)

    a.add(req('a2', 3, A))
    await a.storage.saveConversations([a.screen!])

    expect(a.revisions()).toEqual([1, 2])
    expect(entryIds(a.upserts[1].payload)).toEqual(['a1', 'b1', 'a2'])
    expect(db.row()).toMatchObject({ revision: 3 })
    expect(entryIds(db.row()!.payload)).toEqual(['a1', 'b1', 'a2'])
    expect(a.updater).toHaveBeenCalledTimes(1)
    expect(a.ids()).toEqual(['a1', 'b1', 'a2'])
  })

  it('dois conflitos seguidos: relê e mescla a cada um, e a terceira tentativa grava', async () => {
    const db = sharedDb()
    db.remoteWrite([req('a1', 1, A)])
    const a = await bootPc(db, A)
    await openCentral(a)
    a.storage.registerCentralUpdater(a.updater)
    db.remoteWrite([req('a1', 1, A), req('b1', 2, B)]) // rev 2
    a.afterRereads(() => db.remoteWrite([req('a1', 1, A), req('b1', 2, B), req('b2', 4, B)])) // rev 3

    a.add(req('a2', 3, A))
    await a.storage.saveConversations([a.screen!])

    expect(a.revisions()).toEqual([1, 2, 3])
    expect(a.upserts.map((u) => entryIds(u.payload))).toEqual([
      ['a1', 'a2'],
      ['a1', 'b1', 'a2'],
      ['a1', 'b1', 'a2', 'b2']
    ])
    expect(db.row()).toMatchObject({ revision: 4 })
    expect(entryIds(db.row()!.payload)).toEqual(['a1', 'b1', 'a2', 'b2'])
    expect(a.updater).toHaveBeenCalledTimes(1) // uma entrega só: o remoto mais novo relido
    expect(a.ids()).toEqual(['a1', 'b1', 'a2', 'b2'])
  })

  it('todos conflitando (1 tentativa + 3 rebases): o erro sobe, a tela já tem o mais novo relido e o próximo salvamento grava', async () => {
    const db = sharedDb()
    db.remoteWrite([req('a1', 1, A)])
    const a = await bootPc(db, A)
    await openCentral(a)
    a.storage.registerCentralUpdater(a.updater)
    const fromB = [req('b1', 2, B), req('b2', 4, B), req('b3', 5, B), req('b4', 6, B)]
    const bWrites = (n: number) => () => db.remoteWrite([req('a1', 1, A), ...fromB.slice(0, n)])
    bWrites(1)() // rev 2
    a.afterRereads(bWrites(2), bWrites(3), bWrites(4)) // revs 3, 4 e 5: toda nova tentativa perde

    a.add(req('a2', 3, A))
    await expect(a.storage.saveConversations([a.screen!])).rejects.toThrow(/REVISION_CONFLICT/)
    expect(a.revisions()).toEqual([1, 2, 3, 4])
    expect(entryIds(db.row()!.payload)).toEqual(['a1', 'b1', 'b2', 'b3', 'b4'])
    expect(a.updater).toHaveBeenCalledTimes(1)
    expect(a.ids()).toEqual(['a1', 'b1', 'a2', 'b2', 'b3']) // a rev 4, a última relida

    await a.storage.saveConversations([a.screen!]) // parte da 4 relida → conflito → relê a 5 → grava
    expect(a.revisions()).toEqual([1, 2, 3, 4, 4, 5])
    expect(entryIds(db.row()!.payload)).toEqual(['a1', 'b1', 'a2', 'b2', 'b3', 'b4'])
    expect(a.ids()).toEqual(['a1', 'b1', 'a2', 'b2', 'b3', 'b4'])
  })

  it('gravação capturada antes de a tela receber o remoto do conflito não apaga as entradas do outro PC', async () => {
    const db = sharedDb()
    db.remoteWrite([req('a1', 1, A)])
    const a = await bootPc(db, A)
    await openCentral(a)
    a.storage.registerCentralUpdater(a.updater)
    db.remoteWrite([req('a1', 1, A), req('b1', 2, B)])

    const release = a.hold()
    a.add(req('a2', 3, A))
    const first = a.storage.saveConversations([a.screen!]) // parte da rev 1 e fica na rede
    await vi.waitFor(() => expect(a.upserts).toHaveLength(1))
    a.add(req('a3', 4, A))
    const second = a.storage.saveConversations([a.screen!]) // capturada sem b1, roda depois da primeira
    release()
    await Promise.all([first, second])

    // A segunda passa no CAS (rev 3 = a da primeira), mas leva o b1 que a rev 3 tem.
    expect(a.revisions()).toEqual([1, 2, 3])
    expect(entryIds(a.upserts[2].payload)).toEqual(['a1', 'b1', 'a2', 'a3'])
    expect(entryIds(db.row()!.payload)).toEqual(['a1', 'b1', 'a2', 'a3'])
    expect(a.ids()).toEqual(['a1', 'b1', 'a2', 'a3'])
  })
})

describe('Central com atualizador: feed de mudanças', () => {
  it('suja ou limpa, é mesclada pelo atualizador, fica fora do resultado e a revisão conhecida não anda', async () => {
    const db = sharedDb()
    db.remoteWrite([req('a1', 1, A)])
    const a = await bootPc(db, A)
    await openCentral(a)
    a.storage.registerCentralUpdater(a.updater)

    db.remoteWrite([req('a1', 1, A), req('b1', 2, B)])
    let updates = await a.storage.loadConversationChanges([change(2, B)])
    expect(updates.has(CENTRAL_ID)).toBe(false)
    expect(a.ids()).toEqual(['a1', 'b1'])

    // Suja: entrada daqui ainda esperando o debounce.
    a.add(req('a2', 3, A))
    a.storage.markConversationsDirty([CENTRAL_ID])
    db.remoteWrite([req('a1', 1, A), req('b1', 2, B), req('b2', 4, B)])
    updates = await a.storage.loadConversationChanges([change(3, B)])
    expect(updates.size).toBe(0)
    expect(a.ids()).toEqual(['a1', 'b1', 'a2', 'b2'])
    expect(a.updater).toHaveBeenCalledTimes(2)

    // A revisão conhecida ainda é a da abertura: a gravação parte dela, dá conflito e mescla.
    await a.storage.saveConversations([a.screen!])
    expect(a.revisions()).toEqual([1, 3])
    expect(entryIds(db.row()!.payload)).toEqual(['a1', 'b1', 'a2', 'b2'])
  })

  it('gravação enfileirada ANTES da mescla do feed dá conflito e mescla, em vez de regravar por cima', async () => {
    const db = sharedDb()
    db.remoteWrite([req('a1', 1, A)])
    const a = await bootPc(db, A)
    await openCentral(a)
    a.storage.registerCentralUpdater(a.updater)

    const release = a.hold()
    a.add(req('a2', 3, A))
    const saving = a.storage.saveConversations([a.screen!])
    await vi.waitFor(() => expect(a.upserts).toHaveLength(1))
    db.remoteWrite([req('a1', 1, A), req('b1', 2, B)]) // o B grava enquanto ela está na rede
    await a.storage.loadConversationChanges([change(2, B)])
    expect(a.ids()).toEqual(['a1', 'b1', 'a2'])
    release()
    await saving

    expect(a.revisions()).toEqual([1, 2])
    expect(entryIds(db.row()!.payload)).toEqual(['a1', 'b1', 'a2'])
  })

  it('cópia capturada antes da mescla e gravada depois (debounce) ainda parte da revisão antiga e mescla', async () => {
    const db = sharedDb()
    db.remoteWrite([req('a1', 1, A)])
    const a = await bootPc(db, A)
    await openCentral(a)
    a.storage.registerCentralUpdater(a.updater)

    const stale: Conversation = { ...a.screen!, central: { entries: [req('a1', 1, A), req('a2', 3, A)] } }
    db.remoteWrite([req('a1', 1, A), req('b1', 2, B)])
    await a.storage.loadConversationChanges([change(2, B)])
    await a.storage.saveConversations([stale])

    expect(a.revisions()).toEqual([1, 2])
    expect(entryIds(db.row()!.payload)).toEqual(['a1', 'b1', 'a2'])
  })

  it('leitura do feed que volta fora de ordem não tira da tela o que o outro PC já tinha', async () => {
    const db = sharedDb()
    db.remoteWrite([req('a1', 1, A)])
    const a = await bootPc(db, A)
    await openCentral(a)
    a.storage.registerCentralUpdater(a.updater)
    await a.storage.loadConversationChanges([]) // guarda o installationId

    const rev2 = db.remoteWrite([req('a1', 1, A), req('b1', 2, B)])
    db.remoteWrite([req('a1', 1, A), req('b1', 2, B), req('b2', 4, B)])
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

describe('Central sem atualizador registrado: o comportamento de hoje', () => {
  it('conflito: regrava a cópia local inteira na revisão relida, sem mesclar', async () => {
    const db = sharedDb()
    db.remoteWrite([req('a1', 1, A)])
    const a = await bootPc(db, A)
    await openCentral(a)
    db.remoteWrite([req('a1', 1, A), req('b1', 2, B)])

    a.add(req('a2', 3, A))
    await a.storage.saveConversations([a.screen!])

    expect(a.revisions()).toEqual([1, 2])
    // É o defeito que o atualizador corrige: o b1 do outro PC some da linha.
    expect(entryIds(db.row()!.payload)).toEqual(['a1', 'a2'])
  })

  it('feed: a limpa volta inteira no resultado (e a revisão conhecida anda); a suja é pulada', async () => {
    const db = sharedDb()
    db.remoteWrite([req('a1', 1, A)])
    const a = await bootPc(db, A)
    await openCentral(a)

    db.remoteWrite([req('a1', 1, A), req('b1', 2, B)])
    const updates = await a.storage.loadConversationChanges([change(2, B)])
    expect(entryIds(updates.get(CENTRAL_ID))).toEqual(['a1', 'b1'])
    a.screen = updates.get(CENTRAL_ID)!
    a.add(req('a2', 3, A))
    await a.storage.saveConversations([a.screen])
    expect(a.revisions()).toEqual([2])

    a.storage.markConversationsDirty([CENTRAL_ID])
    db.remoteWrite([req('b9', 9, B)])
    expect((await a.storage.loadConversationChanges([change(4, B)])).size).toBe(0)
  })

  it('registrar e depois desregistrar (null) volta ao comportamento de hoje', async () => {
    const db = sharedDb()
    db.remoteWrite([req('a1', 1, A)])
    const a = await bootPc(db, A)
    await openCentral(a)
    a.storage.registerCentralUpdater(a.updater)
    a.storage.registerCentralUpdater(null)

    db.remoteWrite([req('a1', 1, A), req('b1', 2, B)])
    const updates = await a.storage.loadConversationChanges([change(2, B)])
    expect(entryIds(updates.get(CENTRAL_ID))).toEqual(['a1', 'b1'])
    expect(a.updater).not.toHaveBeenCalled()
  })
})

describe('outras conversas não mudam, mesmo com o atualizador da Central registrado', () => {
  const chat = { id: 'c1', title: 'Chat', cwd: '', messages: [], createdAt: NOW, updatedAt: NOW }

  it('conflito regrava a cópia local; feed troca a limpa e pula a suja; o atualizador nunca é chamado', async () => {
    const db = sharedDb()
    db.put('c1', chat)
    const a = await bootPc(db, A)
    const [loaded] = await a.storage.loadConversationsByIds(['c1'])
    a.storage.registerCentralUpdater(a.updater)

    db.put('c1', { ...chat, title: 'Renomeada no B' })
    await a.storage.saveConversations([{ ...loaded, title: 'Editada aqui' }])
    expect(a.upserts.map((u) => [u.expectedRevision, u.payload.title])).toEqual([
      [1, 'Editada aqui'],
      [2, 'Editada aqui']
    ])

    db.put('c1', { ...chat, title: 'De novo no B' }) // rev 4
    const updates = await a.storage.loadConversationChanges([change(4, B, 'c1')])
    expect(updates.get('c1')).toMatchObject({ title: 'De novo no B' })

    a.storage.markConversationsDirty(['c1'])
    db.put('c1', { ...chat, title: 'Mais uma no B' }) // rev 5
    expect((await a.storage.loadConversationChanges([change(5, B, 'c1')])).size).toBe(0)
    expect(a.updater).not.toHaveBeenCalled()
  })

  it('dois conflitos seguidos: rebase uma vez só (os 3 são só da Central) e o segundo conflito sobe', async () => {
    const db = sharedDb()
    db.put('c1', chat)
    const a = await bootPc(db, A)
    const [loaded] = await a.storage.loadConversationsByIds(['c1'])
    a.storage.registerCentralUpdater(a.updater)
    db.put('c1', { ...chat, title: 'No B' }) // rev 2
    a.afterRereads(() => db.put('c1', { ...chat, title: 'De novo no B' })) // rev 3

    await expect(a.storage.saveConversations([{ ...loaded, title: 'Editada aqui' }])).rejects.toThrow(/REVISION_CONFLICT/)
    expect(a.revisions()).toEqual([1, 2])
    expect(a.updater).not.toHaveBeenCalled()
  })
})

describe('corrida de dois PCs (banco compartilhado, window.api simulado)', () => {
  it('as entradas dos dois sobrevivem no conflito e no feed, inclusive com gravação enfileirada antes do feed', async () => {
    const db = sharedDb()
    const a = await bootPc(db, A)
    const b = await bootPc(db, B)

    // A cria a Central e grava (rev 1).
    a.use()
    a.storage.registerCentralUpdater(a.updater)
    a.screen = central([req('a1', 1, A)])
    await a.storage.saveConversations([a.screen])

    // B abre (leitura por id, como o boot da Central) e grava b1 (rev 2).
    await openCentral(b)
    b.storage.registerCentralUpdater(b.updater)
    b.add(req('b1', 2, B))
    await b.storage.saveConversations([b.screen!])
    expect(db.row()).toMatchObject({ revision: 2 })

    // Conflito: o A ainda conhece a rev 1 e grava a2 → relê, mescla, grava a rev 3, a tela dele ganha b1.
    a.use()
    a.add(req('a2', 3, A))
    await a.storage.saveConversations([a.screen!])
    expect(a.ids()).toEqual(['a1', 'b1', 'a2'])

    // Feed no B: a gravação do A chega mesclada.
    b.use()
    await b.storage.loadConversationChanges([change(3, A)])
    expect(b.ids()).toEqual(['a1', 'b1', 'a2'])

    // Gravação do B enfileirada antes do feed: fica na rede enquanto o A grava a3 (rev 4).
    b.add(req('b2', 4, B))
    const release = b.hold()
    const bSaving = b.storage.saveConversations([b.screen!])
    await vi.waitFor(() => expect(b.upserts).toHaveLength(2))
    a.use()
    a.add(req('a3', 5, A))
    await a.storage.saveConversations([a.screen!])
    b.use()
    await b.storage.loadConversationChanges([change(4, A)])
    expect(b.ids()).toEqual(['a1', 'b1', 'a2', 'b2', 'a3'])
    release()
    await bSaving // parte da rev 2 → conflito → relê a 4 → mescla → rev 5

    a.use()
    await a.storage.loadConversationChanges([change(5, B)])

    const all = ['a1', 'b1', 'a2', 'b2', 'a3']
    expect(db.row()).toMatchObject({ revision: 5 })
    expect(entryIds(db.row()!.payload)).toEqual(all)
    expect(a.ids()).toEqual(all)
    expect(b.ids()).toEqual(all)
    expect(b.revisions()).toEqual([1, 2, 4])
  })
})
