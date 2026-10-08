import { describe, expect, it } from 'vitest'
import { CENTRAL_ID, type CentralEntry } from '@shared/central'
import type { VersionedConversationDto } from '@shared/ipc'
import type { Conversation } from '../types'
import { createCentralStorage } from './centralMergeStorage'

// As entregas à tela com dependências falsas; o fluxo com a storage de verdade está em storage.central.test.ts.

const req = (id: string, ts: number, device: string): CentralEntry =>
  ({ kind: 'request', id, ts, text: id, state: 'delivered', device }) as CentralEntry

const conv = (entries: CentralEntry[]): Conversation => ({
  id: CENTRAL_ID,
  title: 'Central',
  cwd: '',
  model: 'claude-opus-5-5',
  sdkSessionId: null,
  messages: [],
  tokens: { context: 0, output: 0, cost: 0 },
  createdAt: 1,
  updatedAt: 1,
  central: { entries }
})

const record = (revision: number, entries: CentralEntry[], extra: Partial<VersionedConversationDto> = {}): VersionedConversationDto => ({
  id: CENTRAL_ID,
  payload: conv(entries) as unknown as Record<string, unknown>,
  revision,
  contentHash: `h${revision}`,
  createdAt: '2026-10-02T12:00:00.000Z',
  updatedAt: '2026-10-02T12:00:00.000Z',
  ...extra
})

function setup(knownRevision?: number) {
  const central = createCentralStorage({
    knownRevision: () => knownRevision,
    normalize: (r) => r.payload as unknown as Conversation
  })
  const view = { screen: conv([req('a1', 1, 'pc-a'), req('a2', 3, 'pc-a')]) }
  central.register((fn) => (view.screen = fn(view.screen)))
  return { central, view, ids: () => view.screen.central?.entries.map((e) => e.id) }
}

describe('createCentralStorage: entregas à tela', () => {
  it('feed: o que a leitura já trouxe não é reentregue; o mais novo é mesclado por dono', () => {
    const { central, ids } = setup(2)
    central.mergeChange(record(2, [req('b0', 0, 'pc-b')]), 'pc-a')
    expect(ids()).toEqual(['a1', 'a2'])
    central.mergeChange(record(3, [req('a1', 1, 'pc-a'), req('b1', 2, 'pc-b')]), 'pc-a')
    expect(ids()).toEqual(['a1', 'b1', 'a2'])
  })

  it('remoto relido pela fila: entra mesclado; tombstone e outra conversa não', () => {
    const { central, ids } = setup()
    central.mergeRemote(record(4, [req('b1', 2, 'pc-b')], { deletedAt: '2026-10-02T12:00:00.000Z' }), 'pc-a')
    central.mergeRemote({ ...record(5, [req('b1', 2, 'pc-b')]), id: 'outra' }, 'pc-a')
    expect(ids()).toEqual(['a1', 'a2'])
    central.mergeRemote(record(6, [req('b1', 2, 'pc-b')]), 'pc-a')
    expect(ids()).toEqual(['a1', 'b1', 'a2'])
  })

  it('sem atualizador registrado, não desvia nada', () => {
    const central = createCentralStorage({ knownRevision: () => undefined, normalize: (r) => r.payload as unknown as Conversation })
    expect(central.handles(CENTRAL_ID)).toBe(false)
    central.register(() => undefined)
    expect(central.handles(CENTRAL_ID)).toBe(true)
    expect(central.handles('c1')).toBe(false)
  })
})
