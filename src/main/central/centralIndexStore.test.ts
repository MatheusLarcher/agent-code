// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistenceRepository, RepositoryChange, RepositoryChangeHandler } from '../persistence/types'

// sandbox.ts puxa ./store (electron + node:sqlite); aqui só o predicado de pasta importa.
const { getCacheInfo } = vi.hoisted(() => ({ getCacheInfo: vi.fn(() => ({ localDir: 'C:\\local' })) }))
vi.mock('../store', () => ({ getCacheInfo }))
// O resumidor de verdade, mas espiável: o cache só vale se ele NÃO rodar de novo.
vi.mock('./centralIndex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./centralIndex')>()
  return { ...actual, summarizeConversation: vi.fn(actual.summarizeConversation) }
})

import { summarizeConversation, type VersionedConversationLike } from './centralIndex'
import { createCentralIndexStore, type CentralIndexStoreDeps, type CentralLoadQuery } from './centralIndexStore'
import { BASE, PROJ_A, PROJ_B, SANDBOX_ROOT, change, conv, ids, makeDb, makeStore, setup } from './centralStoreTestKit'

// O feed, a concorrência e o invalidate: centralIndexStore.feed.test.ts.
// A rede de segurança (10 min), as falhas e o dispose: centralIndexStore.safety.test.ts.

const summarize = vi.mocked(summarizeConversation)

beforeEach(() => {
  // Zera as chamadas e volta ao resumidor de verdade (um teste pode trocá-lo).
  summarize.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Carga e cache
// ---------------------------------------------------------------------------

describe('createCentralIndexStore — carga e cache', () => {
  it('não carrega nada ao criar; assina o feed de mudanças', () => {
    const db = makeDb([conv('a')])
    const { listeners } = setup(db)
    expect(db.load).not.toHaveBeenCalled()
    expect(listeners.size).toBe(1)
  })

  it('a 1ª chamada carrega tudo (sem apagadas) uma vez; as seguintes reusam o cache', async () => {
    const db = makeDb([conv('a'), conv('b')])
    const { store } = setup(db)
    const first = await store.getIndex()
    expect(db.load).toHaveBeenCalledTimes(1)
    expect(db.load).toHaveBeenCalledWith({ includeDeleted: false })
    expect(ids(first)).toEqual(['a', 'b'])
    expect(await store.getIndex()).toBe(first)
    expect(await store.getIndex()).toBe(first)
    expect(db.load).toHaveBeenCalledTimes(1)
    expect(summarize).toHaveBeenCalledTimes(2)
  })

  it('entrega só resumos (nenhum pedaço do payload fica no índice)', async () => {
    const db = makeDb([conv('a', { messages: [{ kind: 'user', id: 'u', text: 'oi' }], segredo: 'x' })])
    const index = await makeStore(db).getIndex()
    const summary = index.byId.get('a')!
    expect(Object.keys(summary).sort()).toEqual(
      ['answerStart', 'convId', 'cwd', 'files', 'firstRequest', 'lastRequests', 'project', 'sandbox', 'title', 'updatedAt'].sort()
    )
    expect(summary).toMatchObject({ convId: 'a', title: 'Conversa a', firstRequest: 'oi', project: 'proj-a', sandbox: false })
    expect(JSON.stringify(index.projects)).not.toContain('segredo')
  })

  it('o resumo só é refeito quando o updatedAt da conversa muda', async () => {
    const db = makeDb([conv('a'), conv('b')])
    const { store } = setup(db)
    const first = await store.getIndex()
    expect(summarize).toHaveBeenCalledTimes(2)

    // Recarga completa com as MESMAS linhas: nenhum resumo é refeito.
    store.invalidate()
    const second = await store.getIndex()
    expect(db.load).toHaveBeenCalledTimes(2)
    expect(summarize).toHaveBeenCalledTimes(2)
    expect(second.byId.get('a')).toBe(first.byId.get('a'))
    expect(second.byId.get('b')).toBe(first.byId.get('b'))

    // A `b` mudou: só ela é refeita.
    db.put(conv('b', { updatedAt: 2_000 }))
    store.invalidate()
    const third = await store.getIndex()
    expect(summarize).toHaveBeenCalledTimes(3)
    expect(summarize.mock.calls[2][0].id).toBe('b')
    expect(third.byId.get('b')?.updatedAt).toBe(2_000)
    expect(third.byId.get('a')).toBe(first.byId.get('a'))
  })

  it('renomear (a linha muda, o updatedAt do payload não) também atualiza o resumo', async () => {
    const db = makeDb([conv('a')])
    const { store } = setup(db)
    expect((await store.getIndex()).byId.get('a')?.title).toBe('Conversa a')
    db.put(conv('a', { title: 'Novo nome' }, { revision: 2, updatedAt: '2026-10-02T11:00:00.000Z' }))
    store.invalidate()
    expect((await store.getIndex()).byId.get('a')?.title).toBe('Novo nome')
    expect(summarize).toHaveBeenCalledTimes(2)
  })

  it('a pasta deste PC entra na versão: mudar só o cwd (mesma linha, mesmo updatedAt) refaz o resumo', async () => {
    // No Postgres o cwd vem do estado do dispositivo: mapear ou mover o projeto aqui não mexe na linha.
    const db = makeDb([conv('outro-pc', { cwd: '' }), conv('movida'), conv('igual')])
    const { store } = setup(db)
    const first = await store.getIndex()
    expect(ids(first)).toEqual(['igual', 'movida'])
    summarize.mockClear()

    db.put(conv('outro-pc', { cwd: 'D:\\repos\\proj' }))
    db.put(conv('movida', { cwd: PROJ_B }))
    db.put(conv('igual'))
    store.invalidate()
    const next = await store.getIndex()
    expect(summarize.mock.calls.map(([row]) => row.id).sort()).toEqual(['movida', 'outro-pc'])
    expect(ids(next)).toEqual(['igual', 'movida', 'outro-pc'])
    expect(next.byId.get('outro-pc')).toMatchObject({ cwd: 'D:\\repos\\proj', project: 'proj' })
    expect(next.projects.find((p) => p.cwd === PROJ_B)?.conversations.map((c) => c.convId)).toEqual(['movida'])
    expect(next.byId.get('igual')).toBe(first.byId.get('igual'))
  })

  it('a recarga pelo feed também vê a pasta nova: a conversa que ganhou pasta aqui entra no índice', async () => {
    const db = makeDb([conv('a'), conv('outro-pc', { cwd: '' })])
    const { store, emit } = setup(db)
    expect(ids(await store.getIndex())).toEqual(['a'])
    db.put(conv('outro-pc', { cwd: 'D:\\repos\\proj' }))
    emit(change('outro-pc'))
    expect((await store.getIndex()).byId.get('outro-pc')).toMatchObject({ cwd: 'D:\\repos\\proj', project: 'proj' })
  })

  it('o índice guarda o projeto, o sandbox e a recência como o construtor define', async () => {
    const db = makeDb([
      conv('a', { updatedAt: 10 }),
      conv('b', { cwd: PROJ_B, updatedAt: 30 }),
      conv('s1', { cwd: join(SANDBOX_ROOT, 'x1'), updatedAt: 20 }),
      conv('s2', { cwd: join(SANDBOX_ROOT, 'x2'), updatedAt: 5 })
    ])
    const index = await makeStore(db).getIndex()
    expect(index.projects.map((p) => p.name)).toEqual(['proj-b', 'sandbox', 'proj-a'])
    const group = index.projects[1]
    expect(group).toMatchObject({ sandbox: true, cwd: SANDBOX_ROOT, updatedAt: 20 })
    expect(group.conversations.map((c) => c.cwd)).toEqual([join(SANDBOX_ROOT, 'x1'), join(SANDBOX_ROOT, 'x2')])
  })

  it('sem sandboxRoot injetado usa a raiz do app (<localDir>\\sandbox)', async () => {
    const root = join('C:\\local', 'sandbox')
    const db = makeDb([conv('s', { cwd: join(root, 'abc') }), conv('p')])
    const store = createCentralIndexStore({ load: db.load, exists: () => true })
    const index = await store.getIndex()
    expect(index.byId.get('s')).toMatchObject({ sandbox: true, project: 'sandbox' })
    expect(index.byId.get('p')).toMatchObject({ sandbox: false })
    expect(index.projects.find((p) => p.sandbox)?.cwd).toBe(root)
    store.dispose()
  })

  it('falha ao descobrir a raiz do sandbox rejeita (não vira "linha ruim") e a próxima chamada tenta de novo', async () => {
    const db = makeDb([conv('a')])
    const store = createCentralIndexStore({ load: db.load, exists: () => true })
    getCacheInfo.mockImplementationOnce(() => {
      throw new Error('app ainda não pronto')
    })
    await expect(store.getIndex()).rejects.toThrow('app ainda não pronto')
    expect(ids(await store.getIndex())).toEqual(['a'])
    store.dispose()
  })
})

// ---------------------------------------------------------------------------
// Exclusões
// ---------------------------------------------------------------------------

describe('createCentralIndexStore — exclusões', () => {
  it('fora do índice: a Central, planejamento, apagadas, sem pasta e pasta inexistente', async () => {
    const gone = join(BASE, 'gone')
    const db = makeDb([
      conv('a'),
      conv('central', { mode: 'central', cwd: '' }),
      conv('outro-id', { mode: 'central' }),
      conv('plan', { mode: 'planning' }),
      conv('del', {}, { deletedAt: '2026-10-01T00:00:00.000Z' }),
      conv('nocwd', { cwd: '' }),
      conv('missing', { cwd: gone })
    ])
    // Um carregador que devolve também as apagadas: o store descarta por conta própria.
    const index = await makeStore(db, {
      load: async () => [...db.rows.values()],
      exists: (path) => path !== gone
    }).getIndex()
    expect(ids(index)).toEqual(['a'])
    expect(index.projects.map((p) => p.name)).toEqual(['proj-a'])
  })

  it('a pasta é conferida a cada montagem do índice: o que passa a existir entra, o que some sai', async () => {
    let present = new Set([PROJ_A])
    const db = makeDb([conv('a'), conv('b', { cwd: PROJ_B })])
    const { store, emit } = setup(db, { exists: (path) => present.has(path) })
    expect(ids(await store.getIndex())).toEqual(['a'])

    present = new Set([PROJ_A, PROJ_B])
    emit(change('a')) // qualquer recarga remonta o índice e reconfere as pastas
    expect(ids(await store.getIndex())).toEqual(['a', 'b'])

    present = new Set([PROJ_B])
    store.invalidate('b')
    expect(ids(await store.getIndex())).toEqual(['b'])
  })

  it('o exists padrão olha o disco de verdade', async () => {
    const real = await mkdtemp(join(tmpdir(), 'ac-central-real-'))
    try {
      const db = makeDb([conv('here', { cwd: real }), conv('nowhere', { cwd: join(real, 'nao-existe') })])
      const store = createCentralIndexStore({ load: db.load, sandboxRoot: SANDBOX_ROOT })
      expect(ids(await store.getIndex())).toEqual(['here'])
      store.dispose()
    } finally {
      await rm(real, { recursive: true, force: true })
    }
  })

  it('linha ruim não derruba o índice nem leva as boas junto', async () => {
    const rows = [
      conv('a'),
      { id: 'x1', payload: null },
      { id: 'x2', payload: { cwd: PROJ_A, messages: 'oops' } },
      null,
      undefined,
      'lixo',
      42,
      { payload: { cwd: PROJ_A } },
      conv('c')
    ]
    const index = await makeStore(makeDb(), { load: async () => rows as unknown as VersionedConversationLike[] }).getIndex()
    expect(ids(index)).toEqual(['a', 'c'])
  })

  it('resumidor que lança numa linha só pula aquela linha (e não a refaz enquanto a versão for a mesma)', async () => {
    const db = makeDb([conv('a'), conv('boom'), conv('c')])
    const real = summarize.getMockImplementation()!
    summarize.mockImplementation((row, isSandbox) => {
      if (row.id === 'boom') throw new Error('bug no resumidor')
      return real(row, isSandbox)
    })
    const store = makeStore(db)
    expect(ids(await store.getIndex())).toEqual(['a', 'c'])
    expect(summarize).toHaveBeenCalledTimes(3)

    summarize.mockClear()
    store.invalidate()
    expect(ids(await store.getIndex())).toEqual(['a', 'c'])
    expect(summarize).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Encaixe com o repositório real
// ---------------------------------------------------------------------------

/** Só compila se o repositório e o feed REAIS encaixam nas dependências (a Etapa 3 liga um no outro). */
function wireToRealRepository(
  repository: PersistenceRepository,
  subscribeChanges: (handler: RepositoryChangeHandler) => () => void
): CentralIndexStoreDeps {
  return {
    load: (query) => repository.loadConversations(query),
    subscribe: (handler) => subscribeChanges(handler)
  }
}

describe('createCentralIndexStore — encaixe com o repositório e o feed reais', () => {
  it('lê pelo loadConversations e ouve o lote de RepositoryChange do feed', async () => {
    const db = makeDb([conv('a'), conv('b')])
    const loadConversations = vi.fn((query?: CentralLoadQuery) => db.load(query))
    const repository = { loadConversations } as unknown as PersistenceRepository
    let feed: RepositoryChangeHandler = () => undefined
    const unsubscribe = vi.fn()
    const deps = wireToRealRepository(repository, (handler) => {
      feed = handler
      return unsubscribe
    })
    const store = createCentralIndexStore({ ...deps, exists: () => true, sandboxRoot: SANDBOX_ROOT })

    expect(ids(await store.getIndex())).toEqual(['a', 'b'])
    expect(loadConversations).toHaveBeenCalledWith({ includeDeleted: false })

    db.put(conv('b', { title: 'via feed real', updatedAt: 8 }))
    const batch: RepositoryChange[] = [
      { changeId: '1', entity: 'conversation', entityId: 'b', revision: 2, installationId: 'pc-2' },
      { changeId: '2', entity: 'global-kv', entityId: 'config.algo' }
    ]
    feed(batch)
    const next = await store.getIndex()
    expect(loadConversations).toHaveBeenLastCalledWith({ ids: ['b'] })
    expect(next.byId.get('b')?.title).toBe('via feed real')

    store.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
