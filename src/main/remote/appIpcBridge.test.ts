import { describe, it, expect, vi } from 'vitest'
import { Channels } from '../../shared/ipc'
import { REMOTE_IPC_INVOKE } from '../../shared/remoteIpc'
import { OFFICE_BRIDGE_CONV } from '../../shared/officeCall'
import { AppIpcBridge, REMOTE_IPC_FAKE_EVENT, answerAppIpc, appIpcEventLine } from './appIpcBridge'

describe('AppIpcBridge', () => {
  it('handle registra no ipcMain sempre e na ponte só o canal da lista', () => {
    const register = vi.fn()
    const bridge = new AppIpcBridge(register)
    const listener = vi.fn()
    bridge.handle(Channels.boardList, listener)
    bridge.handle('agent:send', listener)
    expect(register).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenCalledWith('agent:send', listener)
    expect(bridge.has(Channels.boardList)).toBe(true)
    expect(bridge.has('agent:send')).toBe(false)
    expect(bridge.channels()).toEqual([Channels.boardList])
  })

  it('invoke de canal fora da lista nunca chama o listener', async () => {
    const bridge = new AppIpcBridge(() => {})
    const listener = vi.fn()
    bridge.handle('agent:send', listener)
    expect(await bridge.invoke('agent:send', ['x'])).toBeNull()
    expect(listener).not.toHaveBeenCalled()
  })

  it('invoke de canal da lista sem handler devolve null', async () => {
    const bridge = new AppIpcBridge(() => {})
    expect(await bridge.invoke(Channels.scrumPanel, [])).toBeNull()
  })

  it('invoke passa o evento falso e os args, e devolve o resultado', async () => {
    const bridge = new AppIpcBridge(() => {})
    const listener = vi.fn(async (_e: unknown, id: string, dismissed: boolean) => ({ id, dismissed }))
    bridge.handle(Channels.boardDismiss, listener)
    expect(await bridge.invoke(Channels.boardDismiss, ['b1', true])).toEqual({ result: { id: 'b1', dismissed: true } })
    expect(listener).toHaveBeenCalledWith(REMOTE_IPC_FAKE_EVENT, 'b1', true)
  })

  it('o erro do listener propaga', async () => {
    const bridge = new AppIpcBridge(() => {})
    bridge.handle(Channels.boardMove, () => {
      throw new Error('quebrou')
    })
    await expect(bridge.invoke(Channels.boardMove, [])).rejects.toThrow('quebrou')
  })

  it('aceita os 15 canais da lista do celular (com as ações da bolinha de tarefas)', () => {
    const bridge = new AppIpcBridge(() => {})
    for (const ch of REMOTE_IPC_INVOKE) bridge.handle(ch, () => null)
    expect(bridge.channels()).toHaveLength(15)
    expect(bridge.has(Channels.tarefasAcao)).toBe(true)
  })
})

describe('answerAppIpc', () => {
  const ok = async (): Promise<{ result: unknown }> => ({ result: { itens: 1 } })

  it('413 sem corpo (grande demais)', async () => {
    expect((await answerAppIpc(null, ok)).status).toBe(413)
  })

  it('400 com JSON ruim, canal fora da lista ou args demais', async () => {
    expect((await answerAppIpc('{', ok)).status).toBe(400)
    expect((await answerAppIpc(JSON.stringify({ channel: 'agent:send', args: [] }), ok)).status).toBe(400)
    expect((await answerAppIpc(JSON.stringify({ channel: Channels.boardList, args: [1, 2, 3, 4, 5] }), ok)).status).toBe(400)
  })

  it('404 sem handler, 500 com erro, 200 com o resultado', async () => {
    const body = JSON.stringify({ channel: Channels.boardList, args: ['/proj'] })
    expect(await answerAppIpc(body, async () => null)).toEqual({ status: 404, body: { ok: false, error: `canal sem handler: ${Channels.boardList}` } })
    expect(await answerAppIpc(body, async () => Promise.reject(new Error('falhou')))).toEqual({ status: 500, body: { ok: false, error: 'falhou' } })
    const invoke = vi.fn(ok)
    expect(await answerAppIpc(body, invoke)).toEqual({ status: 200, body: { ok: true, result: { itens: 1 } } })
    expect(invoke).toHaveBeenCalledWith(Channels.boardList, ['/proj'])
  })

  it('resultado undefined vira null', async () => {
    const body = JSON.stringify({ channel: Channels.scrumPanel })
    expect(await answerAppIpc(body, async () => ({ result: undefined }))).toEqual({ status: 200, body: { ok: true, result: null } })
  })
})

describe('appIpcEventLine', () => {
  it('a linha SSE no envelope do escritório', () => {
    const line = appIpcEventLine(Channels.boardChanged, { projectId: 'p1' })
    expect(line.endsWith('\n\n')).toBe(true)
    expect(JSON.parse(line.slice('data: '.length))).toEqual({
      convId: OFFICE_BRIDGE_CONV,
      event: { kind: 'app-ipc', channel: Channels.boardChanged, payload: { projectId: 'p1' } }
    })
  })
})
