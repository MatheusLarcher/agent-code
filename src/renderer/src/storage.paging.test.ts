import { describe, expect, it, vi } from 'vitest'
import {
  loadConversationChanges,
  loadConversations,
  loadProjectConversations,
  loadProjectCounts
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

  it('loadProjectConversations pede o projeto inteiro e loadProjectCounts vira um mapa', async () => {
    const loadVersionedConversations = vi.fn(async () => [record('a1', 'C:/a'), record('a2', 'C:/a')])
    const countConversationsByProject = vi.fn(async () => [
      { cwd: 'C:/a', total: 9 },
      { cwd: 'C:/b', total: 1 }
    ])
    installApi({ loadVersionedConversations, countConversationsByProject })
    const all = await loadProjectConversations('C:/a')
    expect(loadVersionedConversations).toHaveBeenCalledWith({ cwd: 'C:/a' })
    expect(all.map((c) => c.id)).toEqual(['a1', 'a2'])
    expect(await loadProjectCounts()).toEqual({ 'C:/a': 9, 'C:/b': 1 })
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
