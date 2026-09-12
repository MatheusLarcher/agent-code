// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SLEEP_GUARD_BLOCKERS, startSleepGuard, type PowerSaveBlockerLike } from './sleepGuard'
import { AppRestartCoordinator } from './appRestart'

/** Dublê do powerSaveBlocker do Electron, com o mesmo contrato de ids. */
function fakeBlocker(): PowerSaveBlockerLike & { active: Map<number, string>; starts: string[] } {
  const active = new Map<number, string>()
  let next = 1
  return {
    active,
    starts: [],
    start(type) {
      this.starts.push(type)
      const id = next++
      active.set(id, type)
      return id
    },
    stop(id) {
      active.delete(id)
    },
    isStarted: (id) => active.has(id)
  }
}

describe('sleepGuard', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('bloqueia a suspensão enquanto ocupado e solta ao terminar o turno', () => {
    const blocker = fakeBlocker()
    let busy = false
    const stop = startSleepGuard({ blocker, isBusy: () => busy, isEnabled: () => true, pollMs: 100 })

    expect(blocker.active.size).toBe(0) // ocioso: o PC dorme como sempre

    busy = true
    vi.advanceTimersByTime(100)
    // DISPLAY é a garantia nesta máquina (Modern Standby ignora SYSTEM);
    // EXECUÇÃO é a rede de segurança. Os dois têm de estar ativos.
    expect([...blocker.active.values()].sort()).toEqual([...SLEEP_GUARD_BLOCKERS].sort())

    vi.advanceTimersByTime(300) // segue ocupado: não empilha bloqueios
    expect(blocker.active.size).toBe(2)
    expect(blocker.starts).toHaveLength(2)

    busy = false
    vi.advanceTimersByTime(100)
    expect(blocker.active.size).toBe(0)
    stop()
  })

  it('não bloqueia nada com o interruptor desligado', () => {
    const blocker = fakeBlocker()
    const stop = startSleepGuard({ blocker, isBusy: () => true, isEnabled: () => false, pollMs: 100 })
    vi.advanceTimersByTime(500)
    expect(blocker.starts).toHaveLength(0)
    stop()
  })

  it('reemite o bloqueio se o sistema o derrubar', () => {
    const blocker = fakeBlocker()
    const stop = startSleepGuard({ blocker, isBusy: () => true, isEnabled: () => true, pollMs: 100 })
    expect(blocker.active.size).toBe(2)

    blocker.active.clear() // o SO soltou por fora
    vi.advanceTimersByTime(100)
    expect([...blocker.active.values()].sort()).toEqual([...SLEEP_GUARD_BLOCKERS].sort())
    expect(blocker.starts).toHaveLength(4)
    stop()
  })

  it('parar solta os bloqueios e encerra o polling', () => {
    const blocker = fakeBlocker()
    const stop = startSleepGuard({ blocker, isBusy: () => true, isEnabled: () => true, pollMs: 100 })
    expect(blocker.active.size).toBe(2)

    stop()
    expect(blocker.active.size).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(blocker.starts).toHaveLength(2) // nenhum tique depois de parar
  })

  it('falha do powerSaveBlocker não derruba o app nem trava o guard', () => {
    const blocker = fakeBlocker()
    const start = blocker.start.bind(blocker)
    let fail = true
    blocker.start = ((type) => {
      if (fail) throw new Error('sem suporte')
      return start(type)
    }) as PowerSaveBlockerLike['start']

    const stop = startSleepGuard({ blocker, isBusy: () => true, isEnabled: () => true, pollMs: 100 })
    expect(blocker.active.size).toBe(0)

    fail = false
    vi.advanceTimersByTime(100)
    expect(blocker.active.size).toBe(2)
    stop()
  })

  /**
   * A fiação é o que pode falhar em silêncio: o guard funcionar contra um
   * `isBusy` de mentira e nunca acender no app real. Aqui quem responde é o
   * MESMO coordenador que o `index.ts` consulta.
   */
  it('acende pela ocupação real do coordenador de conversas', () => {
    const blocker = fakeBlocker()
    const host = { arm: vi.fn(), flush: vi.fn(), quit: vi.fn(), report: vi.fn() }
    const coordinator = new AppRestartCoordinator(host as never)
    let busy = false
    const session = coordinator.register('conv-1', () => ({ busy }))
    const stop = startSleepGuard({
      blocker,
      isBusy: () => coordinator.busyNow(),
      isEnabled: () => true,
      pollMs: 100
    })

    expect(blocker.active.size).toBe(0)

    busy = true // turno começou
    vi.advanceTimersByTime(100)
    expect(blocker.active.size).toBe(2)

    busy = false // turno terminou
    vi.advanceTimersByTime(100)
    expect(blocker.active.size).toBe(0)

    // Um envio pendente (antes de a sessão marcar busy) também segura a máquina.
    const leave = coordinator.enter()
    vi.advanceTimersByTime(100)
    expect(blocker.active.size).toBe(2)
    leave()
    vi.advanceTimersByTime(100)
    expect(blocker.active.size).toBe(0)

    // Latch de trabalho destacado (`unsafe`) NÃO pode manter o PC acordado
    // para sempre: ele sobrevive ao fim do turno de propósito.
    session.remove()
    const detached = coordinator.register('conv-2', () => ({ busy: false, unsafe: 'background' }))
    vi.advanceTimersByTime(100)
    expect(blocker.active.size).toBe(0)

    detached.remove()
    stop()
  })
})
