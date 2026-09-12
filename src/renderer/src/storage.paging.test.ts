import { describe, expect, it, vi } from 'vitest'
import {
  loadConversationChanges,
  loadConversations,
  loadConversationsByIds,
  loadProjectConversations,
  loadProjectSummaries,
  loadProjectsPage,
  waitForStorageReady
} from './storage'

function record(id: string, cwd: string, revision = 1) {
  return {
    id,
    payload: { id, cwd, title: id, messages: [], createdAt: 1, updatedAt: 2 },
    revision,
    contentHash: id,
    createdAt: '2026-08-28T12:00:00.000Z',
    updatedAt: '2026-08-29T12:00:00.000Z'
  }
}

function installApi(api: Record<string, unknown>): void {
  Object.defineProperty(window, 'api', { configurable: true, value: api })
}

describe('carga paginada por projeto', () => {
  it('loadConversations pede só a primeira página de cada projeto', async () => {
    const loadVersionedConversations = vi.fn(async () => [record('a1', 'C:/a')])
    installApi({ loadVersionedConversations })
    await loadConversations({ perProject: 6 })
    expect(loadVersionedConversations).toHaveBeenCalledWith({ perProject: 6 })
  })

  it('sem opção, a chamada continua sem query (contrato antigo)', async () => {
    const loadVersionedConversations = vi.fn(async () => [record('a1', 'C:/a')])
    installApi({ loadVersionedConversations })
    await loadConversations()
    expect(loadVersionedConversations).toHaveBeenCalledWith(undefined)
  })

  it('loadProjectConversations pede o projeto inteiro', async () => {
    const loadVersionedConversations = vi.fn(async () => [record('a1', 'C:/a'), record('a2', 'C:/a')])
    installApi({ loadVersionedConversations })
    const all = await loadProjectConversations('C:/a')
    expect(loadVersionedConversations).toHaveBeenCalledWith({ cwd: 'C:/a' })
    expect(all.map((c) => c.id)).toEqual(['a1', 'a2'])
  })

  it('a primeira leitura é só dos projetos pedidos; o resto vem por lote', async () => {
    const loadVersionedConversations = vi.fn(async () => [record('a1', 'C:/a')])
    installApi({ loadVersionedConversations })
    await loadConversations({ perProject: 6, cwds: ['C:/a', 'C:/b'] })
    expect(loadVersionedConversations).toHaveBeenCalledWith({ perProject: 6, cwds: ['C:/a', 'C:/b'] })

    await loadProjectsPage(['C:/c'], 6)
    expect(loadVersionedConversations).toHaveBeenLastCalledWith({ cwds: ['C:/c'], perProject: 6 })

    // Lote vazio não vira consulta nenhuma.
    loadVersionedConversations.mockClear()
    expect(await loadProjectsPage([], 6)).toEqual([])
    expect(await loadConversationsByIds([])).toEqual([])
    expect(loadVersionedConversations).not.toHaveBeenCalled()
  })

  it('loadProjectSummaries ordena por recência e descarta projeto sem pasta', async () => {
    installApi({
      countConversationsByProject: vi.fn(async () => [
        { cwd: 'C:/velho', total: 3, updatedAt: '2026-01-01T00:00:00.000Z' },
        { cwd: '', total: 2, updatedAt: '2026-09-09T00:00:00.000Z' },
        { cwd: 'C:/novo', total: 5, updatedAt: '2026-09-10T00:00:00.000Z' }
      ])
    })
    const summaries = await loadProjectSummaries()
    expect(summaries.map((p) => p.cwd)).toEqual(['C:/novo', 'C:/velho'])
    expect(summaries[0]).toEqual({ cwd: 'C:/novo', total: 5, updatedAt: Date.parse('2026-09-10T00:00:00.000Z') })
  })

  it('espera a persistência sair de "booting" antes de ler qualquer coisa', async () => {
    let notify: ((status: unknown) => void) | null = null
    const statuses = [
      { state: 'booting', writable: false },
      { state: 'booting', writable: false }
    ]
    installApi({
      getStorageStatus: vi.fn(async () => statuses.shift() ?? { state: 'booting', writable: false }),
      onStorageStatusChanged: vi.fn((handler: (status: unknown) => void) => {
        notify = handler
        return () => {
          notify = null
        }
      })
    })
    const pending = waitForStorageReady()
    await Promise.resolve()
    expect(notify).not.toBeNull()
    notify!({ state: 'booting', writable: false })
    notify!({ state: 'postgres-ready', writable: true })
    expect(await pending).toMatchObject({ state: 'postgres-ready' })
    // Assinatura desfeita ao resolver: o efeito de boot não fica pendurado nela.
    expect(notify).toBeNull()
  })

  it('o change feed pede só os ids envolvidos, nunca a tabela inteira', async () => {
    const loadVersionedConversations = vi.fn(async () => [record('x', 'C:/a', 7)])
    installApi({
      loadVersionedConversations,
      getStorageStatus: vi.fn(async () => ({ installationId: 'this-pc' }))
    })
    await loadConversationChanges([{ entity: 'conversation', entityId: 'x', installationId: 'other-pc' } as never])
    expect(loadVersionedConversations).toHaveBeenCalledWith({ ids: ['x'], includeDeleted: true })
  })
})
