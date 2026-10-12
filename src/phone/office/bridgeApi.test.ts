/**
 * A ponte do `window.api` no celular: cada função vira POST /api/ipc com o canal
 * e os argumentos posicionais do PC; `ok:false`/rede LANÇA; os avisos do main
 * chegam pelos `eventTaps` (convId 'office', kind 'app-ipc') e desligam.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentCodeApi } from '@shared/api'
import { Channels } from '@shared/ipc'
import { HttpError } from '../core/net'
import { bridgeApi, installBridgeApi } from './bridgeApi'

type Tap = (msg: { convId?: string; event?: unknown }) => void

function fakeClient(post: (path: string, body: unknown, timeout?: number) => Promise<unknown>) {
  return {
    url: (p: string) => `http://pc${p}`,
    fileUrl: (p: string) => `http://pc/api/file?path=${encodeURIComponent(p)}`,
    post: vi.fn(post) as unknown as <T>(path: string, body: unknown, timeout?: number) => Promise<T>,
    eventTaps: new Set<Tap>()
  }
}

const emit = (taps: Set<Tap>, msg: { convId?: string; event?: unknown }): void => taps.forEach((t) => t(msg))

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('bridgeApi (POST /api/ipc)', () => {
  it('boardList: canal e args posicionais do PC; devolve o result', async () => {
    const board = { available: true, items: [] }
    const c = fakeClient(async () => ({ ok: true, result: board }))
    const q = { projectCwd: 'C:\\p', includeDismissed: false }
    await expect(bridgeApi(c).boardList(q)).resolves.toEqual(board)
    expect(c.post).toHaveBeenCalledWith('/api/ipc', { channel: Channels.boardList, args: [q] }, undefined)
  })

  it('boardMove/boardDismiss mandam os dois argumentos na ordem', async () => {
    const c = fakeClient(async () => ({ ok: true, result: { ok: true } }))
    const api = bridgeApi(c)
    await api.boardMove('b1', 'completed')
    await api.boardDismiss('b1', true)
    expect(c.post).toHaveBeenNthCalledWith(1, '/api/ipc', { channel: Channels.boardMove, args: ['b1', 'completed'] }, undefined)
    expect(c.post).toHaveBeenNthCalledWith(2, '/api/ipc', { channel: Channels.boardDismiss, args: ['b1', true] }, undefined)
  })

  it('scrumAsk tem prazo maior; scrumChatHistory sem pedido manda {}', async () => {
    const c = fakeClient(async () => ({ ok: true, result: {} }))
    const api = bridgeApi(c)
    await api.scrumAsk({ text: 'como vai?' } as Parameters<AgentCodeApi['scrumAsk']>[0])
    await api.scrumChatHistory()
    expect(c.post).toHaveBeenNthCalledWith(1, '/api/ipc', { channel: Channels.scrumAsk, args: [{ text: 'como vai?' }] }, 120_000)
    expect(c.post).toHaveBeenNthCalledWith(2, '/api/ipc', { channel: Channels.scrumChatHistory, args: [{}] }, undefined)
  })

  it('ok:false lança com o error da ponte', async () => {
    const c = fakeClient(async () => ({ ok: false, error: 'canal não permitido' }))
    await expect(bridgeApi(c).scrumPanel()).rejects.toThrow('canal não permitido')
  })

  it('HTTP com envelope ok:false lança o error; 404 sem ele = PC antigo; rede lança', async () => {
    const recusa = fakeClient(async () => {
      throw new HttpError(400, { ok: false, error: 'argumentos inválidos' })
    })
    await expect(bridgeApi(recusa).tasksDetail('t1')).rejects.toThrow('argumentos inválidos')
    const antigo = fakeClient(async () => {
      throw new HttpError(404, null)
    })
    await expect(bridgeApi(antigo).boardItemEvents('b1')).rejects.toThrow('Atualize o agent-code no PC')
    const rede = fakeClient(async () => {
      throw new HttpError(0, null)
    })
    await expect(bridgeApi(rede).boardPrints({ projectCwd: 'C:\\p' } as never)).rejects.toBeInstanceOf(Error)
  })
})

describe('bridgeApi (avisos do main)', () => {
  it('onBoardChanged: só o app-ipc do canal certo no envelope office; desliga', () => {
    const c = fakeClient(async () => ({ ok: true }))
    const cb = vi.fn()
    const off = bridgeApi(c).onBoardChanged(cb)
    expect(c.eventTaps.size).toBe(1)
    const payload = { projectId: 'p1' }
    emit(c.eventTaps, { convId: 'office', event: { kind: 'app-ipc', channel: Channels.boardChanged, payload } })
    emit(c.eventTaps, { convId: 'office', event: { kind: 'app-ipc', channel: Channels.scrumChanged, payload } })
    emit(c.eventTaps, { convId: 'a', event: { kind: 'app-ipc', channel: Channels.boardChanged, payload } })
    emit(c.eventTaps, { convId: 'office', event: { kind: 'text', text: 'oi' } })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(payload)
    off()
    expect(c.eventTaps.size).toBe(0)
    emit(c.eventTaps, { convId: 'office', event: { kind: 'app-ipc', channel: Channels.boardChanged, payload } })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('onScrumChanged escuta o seu canal', () => {
    const c = fakeClient(async () => ({ ok: true }))
    const cb = vi.fn()
    bridgeApi(c).onScrumChanged(cb)
    emit(c.eventTaps, { convId: 'office', event: { kind: 'app-ipc', channel: Channels.scrumChanged, payload: { at: 1 } } })
    expect(cb).toHaveBeenCalledWith({ at: 1 })
  })
})

describe('installBridgeApi', () => {
  it('liga no window.api sem sobrescrever o que já existe', () => {
    const mine = vi.fn()
    ;(window as unknown as { api: Partial<AgentCodeApi> }).api = { boardList: mine as never }
    installBridgeApi(fakeClient(async () => ({ ok: true })))
    const api = (window as unknown as { api: Partial<AgentCodeApi> }).api
    expect(api.boardList).toBe(mine)
    expect(typeof api.boardMove).toBe('function')
    expect(typeof api.onScrumChanged).toBe('function')
  })
})
