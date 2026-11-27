import { describe, expect, it, vi } from 'vitest'

const logged: Array<{ event: string; fields: unknown }> = []
vi.mock('./sessionLog', () => ({ logSession: (event: string, fields: unknown) => logged.push({ event, fields }) }))

const { SessionTiming } = await import('./sessionTiming')

describe('SessionTiming', () => {
  it('1º turno leva as etapas da subida; o 2º só os marcos dele', () => {
    let t = 0
    const timing = new SessionTiming('c1', () => t)
    t = 100; timing.phase('skills')
    t = 300; timing.phase('query')
    t = 1000; timing.turnStart()
    t = 3000; timing.mark('cliInit')
    t = 4000; timing.mark('firstDelta'); timing.mark('firstDelta')
    t = 4500; timing.turnEnd(2000)
    t = 5000; timing.turnStart()
    t = 6000; timing.turnEnd()
    expect(logged[0]).toEqual({ event: 'turn-timing', fields: { convId: 'c1', ms: {
      cliInit: 2000, firstDelta: 3000, result: 3500, api: 2000, 'start.skills': 100, 'start.query': 200, startToSend: 1000
    } } })
    expect(logged[1]).toEqual({ event: 'turn-timing', fields: { convId: 'c1', ms: { result: 1000 } } })
  })
})
