import { describe, expect, it, vi } from 'vitest'
import { BUSY_RECONCILE_QUIET_MS, createBusyReconcile, type BusyReconcileDeps } from './busyReconcile'

function world(over: Partial<BusyReconcileDeps> = {}) {
  let now = 1_000_000
  const busy = new Set(['c1'])
  const events: Record<string, number> = {}
  const release = vi.fn((cid: string) => busy.delete(cid))
  const deps: BusyReconcileDeps = {
    busyIds: () => busy,
    lastEventAt: (cid) => events[cid],
    blocked: () => false,
    waitTurnEnd: async () => ({ settled: true }),
    release,
    now: () => now,
    ...over
  }
  const r = createBusyReconcile(deps)
  return {
    r,
    release,
    busy,
    events,
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe('busyReconcile — "trabalhando" preso com o main parado', () => {
  it('solta depois do silêncio e de duas confirmações de ocioso', async () => {
    const w = world()
    await w.r.tick() // primeira vez: só registra desde quando está ocupada
    w.advance(BUSY_RECONCILE_QUIET_MS)
    await w.r.tick()
    expect(w.release).not.toHaveBeenCalled()
    w.advance(15_000)
    await w.r.tick()
    expect(w.release).toHaveBeenCalledWith('c1')
  })

  it('turno rodando de verdade (main responde timeout) nunca é solto', async () => {
    const w = world({ waitTurnEnd: async () => ({ settled: false }) })
    await w.r.tick()
    for (let i = 0; i < 6; i++) {
      w.advance(BUSY_RECONCILE_QUIET_MS)
      await w.r.tick()
    }
    expect(w.release).not.toHaveBeenCalled()
  })

  it('evento recente zera: só conta silêncio de verdade', async () => {
    const w = world()
    await w.r.tick()
    w.advance(BUSY_RECONCILE_QUIET_MS)
    await w.r.tick() // 1ª confirmação
    w.events.c1 = 1_000_000 + BUSY_RECONCILE_QUIET_MS + 1_000
    w.advance(15_000)
    await w.r.tick()
    expect(w.release).not.toHaveBeenCalled()
  })

  it('evento chegando durante a pergunta ao main desfaz a confirmação', async () => {
    let w: ReturnType<typeof world>
    w = world({
      waitTurnEnd: async () => {
        w.events.c1 = (w.events.c1 ?? 0) + 1
        return { settled: true }
      }
    })
    await w.r.tick()
    for (let i = 0; i < 3; i++) {
      w.advance(BUSY_RECONCILE_QUIET_MS)
      await w.r.tick()
    }
    expect(w.release).not.toHaveBeenCalled()
  })

  it('algo esperando o usuário (bloqueio) segura a ocupação', async () => {
    const waitTurnEnd = vi.fn(async () => ({ settled: true }))
    const w = world({ blocked: () => true, waitTurnEnd })
    await w.r.tick()
    for (let i = 0; i < 3; i++) {
      w.advance(BUSY_RECONCILE_QUIET_MS)
      await w.r.tick()
    }
    expect(waitTurnEnd).not.toHaveBeenCalled()
    expect(w.release).not.toHaveBeenCalled()
  })

  it('falha do IPC não solta nada', async () => {
    const w = world({ waitTurnEnd: async () => Promise.reject(new Error('ipc')) })
    await w.r.tick()
    for (let i = 0; i < 3; i++) {
      w.advance(BUSY_RECONCILE_QUIET_MS)
      await w.r.tick()
    }
    expect(w.release).not.toHaveBeenCalled()
  })
})
