import { afterEach, describe, expect, it, vi } from 'vitest'
import { Channels } from '../../shared/ipc'
import { notifyPlanningChanged, setPlanningChangeSink } from './planningEvents'
import { registerPlanningIpc } from './planningIpc'

const ref = { projectCwd: 'C:/projeto', slug: 'checkout' }

afterEach(() => {
  setPlanningChangeSink(null)
  vi.restoreAllMocks()
})

describe('planningEvents', () => {
  it('sem sink registrado, avisar é no-op', () => {
    expect(() => notifyPlanningChanged(ref)).not.toThrow()
  })

  it('entrega ao sink registrado; o unregister só desfaz se o sink ainda for o mesmo', () => {
    const first = vi.fn()
    const second = vi.fn()
    const releaseFirst = setPlanningChangeSink(first)
    notifyPlanningChanged(ref)
    expect(first).toHaveBeenCalledWith(ref)

    setPlanningChangeSink(second)
    releaseFirst() // registro antigo encerrando não apaga o novo
    notifyPlanningChanged(ref)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('sink que lança não propaga a exceção para quem gravou', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setPlanningChangeSink(() => {
      throw new Error('janela fechada')
    })
    expect(() => notifyPlanningChanged(ref)).not.toThrow()
    expect(warn).toHaveBeenCalled()
  })

  it('registerPlanningIpc liga o sink ao mesmo planning:changed do vigia; close() desliga', () => {
    const sent: { channel: string; payload: unknown }[] = []
    const handle = registerPlanningIpc({
      handle: () => {},
      send: (channel, payload) => void sent.push({ channel, payload }),
      createWatcher: () => ({ watch() {}, unwatch() {}, closeAll() {} })
    })
    notifyPlanningChanged(ref)
    expect(sent).toEqual([{ channel: Channels.planningChanged, payload: ref }])

    handle.close()
    notifyPlanningChanged(ref)
    expect(sent).toHaveLength(1)
  })
})
