import { describe, expect, it } from 'vitest'
import { Channels } from './ipc'
import { isRemoteIpcEvent, parseRemoteIpcRequest, REMOTE_IPC_EVENT_KIND, REMOTE_IPC_MAX_ARGS } from './remoteIpc'

describe('parseRemoteIpcRequest', () => {
  it('aceita canal da lista, com ou sem args', () => {
    expect(parseRemoteIpcRequest({ channel: Channels.boardMove, args: ['c1', 'completed'] })).toEqual({ channel: Channels.boardMove, args: ['c1', 'completed'] })
    expect(parseRemoteIpcRequest({ channel: Channels.scrumPanel })).toEqual({ channel: Channels.scrumPanel, args: [] })
  })

  it('recusa canal fora da lista, args que não são lista e args demais', () => {
    expect(parseRemoteIpcRequest({ channel: Channels.boardChanged, args: [] })).toBeNull()
    expect(parseRemoteIpcRequest({ channel: 'config:set', args: [{}] })).toBeNull()
    expect(parseRemoteIpcRequest({ channel: Channels.boardList, args: 'x' })).toBeNull()
    expect(parseRemoteIpcRequest({ channel: Channels.boardList, args: new Array(REMOTE_IPC_MAX_ARGS + 1).fill(0) })).toBeNull()
    expect(parseRemoteIpcRequest(null)).toBeNull()
    expect(parseRemoteIpcRequest('board:list')).toBeNull()
  })
})

describe('isRemoteIpcEvent', () => {
  it('só os eventos da lista', () => {
    expect(isRemoteIpcEvent({ kind: REMOTE_IPC_EVENT_KIND, channel: Channels.boardChanged, payload: { projectId: 'p' } })).toBe(true)
    expect(isRemoteIpcEvent({ kind: REMOTE_IPC_EVENT_KIND, channel: Channels.scrumChanged, payload: {} })).toBe(true)
    expect(isRemoteIpcEvent({ kind: REMOTE_IPC_EVENT_KIND, channel: Channels.boardList, payload: {} })).toBe(false)
    expect(isRemoteIpcEvent({ kind: 'handoff-aviso', channel: Channels.boardChanged })).toBe(false)
    expect(isRemoteIpcEvent(null)).toBe(false)
  })
})
