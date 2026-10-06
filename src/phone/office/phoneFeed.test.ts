import { describe, expect, it } from 'vitest'
import { deriveOfficeModel } from '@renderer/office/adapter/model'
import { createStore } from '../core/store'
import type { AppState, RemoteClient } from '../core/client'
import type { BridgeEvent, ConvSummary } from '../core/types'
import { PhoneOfficeFeed, track } from './phoneFeed'

const conv = (id: string, busy: boolean): ConvSummary => ({ id, title: `Conversa ${id}`, cwd: 'C:/proj/app', busy, connected: true, updatedAt: Date.now() })

function fakeClient(conversations: ConvSummary[]): RemoteClient & { emit(msg: BridgeEvent): void } {
  const store = createStore({ conversations, convId: null, messages: [], usage: {} } as unknown as AppState)
  const taps = new Set<(msg: BridgeEvent) => void>()
  return {
    store,
    get state() {
      return store.get()
    },
    eventTaps: taps,
    emit: (msg: BridgeEvent) => taps.forEach((t) => t(msg))
  } as unknown as RemoteClient & { emit(msg: BridgeEvent): void }
}

describe('feed do escritório no celular', () => {
  it('as conversas da ponte viram agentes, com quem está ocupado marcado', () => {
    const c = fakeClient([conv('a', true), conv('b', false)])
    const feed = new PhoneOfficeFeed(c)
    const snap = feed.getSnapshot()!
    expect(snap.conversations.map((x) => x.id)).toEqual(['a', 'b'])
    expect(snap.busyIds.has('a')).toBe(true)
    expect(snap.busyIds.has('b')).toBe(false)
    const model = deriveOfficeModel(snap, Date.now())
    expect(model.characters.some((ch) => ch.convId === 'a')).toBe(true)
    feed.dispose()
  })

  it('a ferramenta em uso vem do SSE de qualquer conversa, não só da aberta', () => {
    const c = fakeClient([conv('a', true)])
    const feed = new PhoneOfficeFeed(c)
    c.emit({ convId: 'a', event: { kind: 'turn-start' } })
    c.emit({ convId: 'a', event: { kind: 'tool-use', id: 't1', name: 'Bash', input: { command: 'npm test' }, parentToolUseId: null } })
    const msgs = feed.getSnapshot()!.conversations[0].messages
    expect(msgs.at(-1)).toMatchObject({ kind: 'tool-use', name: 'Bash' })
    feed.dispose()
  })

  it('o histórico curto guarda só o turno atual e no máximo 40 eventos', () => {
    let list = track([], { convId: 'a', event: { kind: 'turn-start' } })
    for (let i = 0; i < 60; i++) list = track(list, { convId: 'a', event: { kind: 'tool-use', id: `t${i}`, name: 'Read', input: {}, parentToolUseId: null } })
    expect(list.length).toBe(40)
    expect(track(list, { convId: 'a', event: { kind: 'turn-start' } })).toHaveLength(1)
  })
})
