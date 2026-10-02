// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { AgentCodeApi } from '../../shared/api'
import type { CentralCorrection, CentralRouteRequest } from '../../shared/central'
import { Channels } from '../../shared/ipc'

// O preload de verdade com o electron de mentira: window.api.centralRoute/centralCorrection
// chegam aos canais que registerCentralIpc atende. (Fica aqui porque src/preload/index.test.ts
// está fora do escopo desta etapa.)
const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: vi.fn(() => '') }
}))

await import('../../preload/index')
const api = electron.exposeInMainWorld.mock.calls[0][1] as AgentCodeApi

describe('preload — Central', () => {
  it('centralRoute e centralCorrection invocam os canais central:*', async () => {
    const req: CentralRouteRequest = { text: 'oi', attachments: [], recent: [] }
    const correction: CentralCorrection = {
      ts: 1,
      text: 'oi',
      attachments: [],
      from: { kind: 'new-sandbox' },
      to: { kind: 'new-conversation', cwd: 'C:\\work\\alpha', project: 'alpha' }
    }
    const answer = { kind: 'ask', options: [], reason: 'typesafe-failed' }
    electron.invoke.mockResolvedValueOnce(answer).mockResolvedValueOnce(undefined)

    await expect(api.centralRoute(req)).resolves.toBe(answer)
    await expect(api.centralCorrection(correction)).resolves.toBeUndefined()
    expect(electron.invoke).toHaveBeenNthCalledWith(1, Channels.centralRoute, req)
    expect(electron.invoke).toHaveBeenNthCalledWith(2, Channels.centralCorrection, correction)
  })
})
