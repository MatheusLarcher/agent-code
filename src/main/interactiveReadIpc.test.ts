// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Channels } from '../shared/ipc'
import { routeInteractiveReads } from './interactiveReadIpc'
import { inInteractiveRead } from './persistence/priorityPool'

describe('routeInteractiveReads', () => {
  it('as leituras que a tela espera rodam na faixa interativa; o resto não', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const ipcMain = {
      handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
        handlers.set(channel, listener)
      }
    }
    routeInteractiveReads(ipcMain)
    ipcMain.handle(Channels.boardList, async (_event, query) => ({ interactive: inInteractiveRead(), query }))
    ipcMain.handle(Channels.conversationsFlush, async () => ({ interactive: inInteractiveRead() }))

    await expect(handlers.get(Channels.boardList)!({}, { projectCwd: 'C:/p' })).resolves.toEqual({
      interactive: true,
      query: { projectCwd: 'C:/p' }
    })
    await expect(handlers.get(Channels.conversationsFlush)!({})).resolves.toEqual({ interactive: false })
  })
})
