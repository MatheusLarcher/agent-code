// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Channels, type AgentEventMsg, type PermissionRequestMsg } from '../shared/ipc'
import type { AgentCodeApi } from '../shared/api'

const electronMock = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  getPathForFile: vi.fn(() => '')
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMock.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMock.invoke,
    on: electronMock.on,
    removeListener: electronMock.removeListener
  },
  webUtils: { getPathForFile: electronMock.getPathForFile }
}))

await import('./index')
const api = electronMock.exposeInMainWorld.mock.calls[0][1] as AgentCodeApi

beforeEach(() => {
  electronMock.invoke.mockReset()
  electronMock.on.mockClear()
  electronMock.removeListener.mockClear()
})

describe('preload — contrato IPC do Codex e do agente', () => {
  it('expõe login/status Codex e inicia GPT pelo mesmo canal agent:start', async () => {
    electronMock.invoke.mockResolvedValue({ ok: true })
    await api.codexStatus()
    await api.codexLogin()
    await api.codexLogout()
    await api.startAgent({ convId: 'c1', cwd: 'C:\\project', model: 'gpt-5.6-sol' })

    expect(electronMock.invoke).toHaveBeenNthCalledWith(1, Channels.codexStatus)
    expect(electronMock.invoke).toHaveBeenNthCalledWith(2, Channels.codexLogin)
    expect(electronMock.invoke).toHaveBeenNthCalledWith(3, Channels.codexLogout)
    expect(electronMock.invoke).toHaveBeenNthCalledWith(
      4,
      Channels.agentStart,
      expect.objectContaining({ model: 'gpt-5.6-sol' })
    )
  })

  it('encaminha tool/subagent events e remove exatamente o listener registrado', () => {
    const callback = vi.fn()
    const unsubscribe = api.onAgentEvent(callback)
    const [, listener] = electronMock.on.mock.calls.find(([channel]) => channel === Channels.agentEvent) as [
      string,
      (event: unknown, payload: AgentEventMsg) => void
    ]
    const payload: AgentEventMsg = {
      convId: 'c1',
      event: {
        kind: 'tool-use',
        id: 'tool-1',
        name: 'Read',
        input: { file_path: 'README.md' },
        parentToolUseId: null
      }
    }

    listener({}, payload)
    expect(callback).toHaveBeenCalledWith(payload)
    unsubscribe()
    expect(electronMock.removeListener).toHaveBeenCalledWith(Channels.agentEvent, listener)
  })

  it('mantém o gate de permissão no mesmo contrato IPC para modelos GPT', async () => {
    const callback = vi.fn()
    const unsubscribe = api.onPermissionRequest(callback)
    const [, listener] = electronMock.on.mock.calls.find(
      ([channel]) => channel === Channels.agentPermissionRequest
    ) as [string, (event: unknown, payload: PermissionRequestMsg) => void]
    const request: PermissionRequestMsg = {
      convId: 'c1',
      req: { id: 'permission-1', toolName: 'Bash', input: { command: 'git status' } }
    }

    listener({}, request)
    expect(callback).toHaveBeenCalledWith(request)
    await api.respondPermission('c1', { id: 'permission-1', behavior: 'deny' })
    expect(electronMock.invoke).toHaveBeenCalledWith(
      Channels.agentPermissionResponse,
      'c1',
      expect.objectContaining({ behavior: 'deny' })
    )
    unsubscribe()
    expect(electronMock.removeListener).toHaveBeenCalledWith(Channels.agentPermissionRequest, listener)
  })
})
