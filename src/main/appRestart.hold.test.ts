// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppRestartCoordinator, UPDATE_HOLD_MESSAGE, UPDATE_HOLD_RECHECK_MS, type RestartHost } from './appRestart'

// A retenção da atualização ("quando os agentes terminarem"): recusa trabalho
// novo, dispara uma vez no instante ocioso, respeita a tarefa agendada, é
// cancelável e nunca vira a reserva do app_restart (que nega ferramentas).

const reports: string[] = []
const host: RestartHost = {
  arm: async () => ({ commit: async () => undefined, cancel: async () => undefined }),
  flush: async () => undefined,
  quit: () => undefined,
  report: (message) => reports.push(message)
}

function coordinator(): AppRestartCoordinator {
  return new AppRestartCoordinator(host)
}

describe('AppRestartCoordinator.holdForUpdate', () => {
  beforeEach(() => {
    reports.length = 0
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('bloqueia trabalho novo com a mensagem da retenção, sem virar reserva', () => {
    const restart = coordinator()
    restart.register('c1', () => ({ busy: true }))
    restart.holdForUpdate(() => undefined)
    expect(restart.updateHold).toBe(true)
    expect(restart.reserved).toBe(false)
    expect(() => restart.assertOpen()).toThrow(UPDATE_HOLD_MESSAGE)
    expect(() => restart.enter()).toThrow(UPDATE_HOLD_MESSAGE)
    // A guarda da troca de banco não conta a retenção como trabalho.
    expect(restart.workStatus().blockedBy).toBe('A conversa "c1" está com um turno em andamento.')
  })

  it('conversa ocupada segura; ao ficar livre e avisar, dispara uma vez só', async () => {
    const restart = coordinator()
    let busy = true
    restart.register('c1', () => ({ busy }))
    const onIdle = vi.fn()
    restart.holdForUpdate(onIdle)
    await vi.advanceTimersByTimeAsync(0)
    restart.changed()
    expect(onIdle).not.toHaveBeenCalled()
    busy = false
    restart.changed()
    expect(onIdle).toHaveBeenCalledTimes(1)
    restart.changed()
    await vi.advanceTimersByTimeAsync(UPDATE_HOLD_RECHECK_MS * 3)
    expect(onIdle).toHaveBeenCalledTimes(1)
    // Trabalho novo continua recusado até soltar.
    expect(() => restart.assertOpen()).toThrow(UPDATE_HOLD_MESSAGE)
  })

  it('tarefa agendada ativa segura, mesmo sem conversa ocupada', async () => {
    const restart = coordinator()
    restart.register('c1', () => ({ busy: false }))
    let tarefa: string | undefined = 'Uma tarefa agendada está em execução.'
    const onIdle = vi.fn()
    const blocked: Array<string | undefined> = []
    restart.holdForUpdate(onIdle, () => tarefa, (b) => blocked.push(b))
    await vi.advanceTimersByTimeAsync(0)
    expect(onIdle).not.toHaveBeenCalled()
    expect(restart.holdBlockedBy()).toBe('Uma tarefa agendada está em execução.')
    tarefa = undefined
    await vi.advanceTimersByTimeAsync(UPDATE_HOLD_RECHECK_MS)
    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(blocked).toEqual(['Uma tarefa agendada está em execução.', undefined])
  })

  it('fim de trabalho que não passa por changed(): o timer de 5 s pega', async () => {
    const restart = coordinator()
    let busy = true
    restart.register('c1', () => ({ busy }))
    const onIdle = vi.fn()
    restart.holdForUpdate(onIdle)
    await vi.advanceTimersByTimeAsync(UPDATE_HOLD_RECHECK_MS)
    expect(onIdle).not.toHaveBeenCalled()
    busy = false
    await vi.advanceTimersByTimeAsync(UPDATE_HOLD_RECHECK_MS)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('ocioso já no agendamento: dispara depois de ceder, não dentro da chamada', async () => {
    const restart = coordinator()
    restart.register('c1', () => ({ busy: false }))
    const onIdle = vi.fn()
    restart.holdForUpdate(onIdle)
    expect(onIdle).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('cancelar solta: enter() volta a funcionar e nada dispara depois', async () => {
    const restart = coordinator()
    let busy = true
    restart.register('c1', () => ({ busy }))
    const onIdle = vi.fn()
    restart.holdForUpdate(onIdle)
    restart.releaseHold()
    expect(restart.updateHold).toBe(false)
    expect(() => restart.assertOpen()).not.toThrow()
    const done = restart.enter()
    done()
    busy = false
    restart.changed()
    await vi.advanceTimersByTimeAsync(UPDATE_HOLD_RECHECK_MS * 2)
    expect(onIdle).not.toHaveBeenCalled()
    expect(restart.holdBlockedBy()).toBeUndefined()
  })

  it('rearmar depois de uma recusa passageira volta a esperar o próximo instante ocioso', async () => {
    const restart = coordinator()
    let busy = false
    restart.register('c1', () => ({ busy }))
    const onIdle = vi.fn()
    restart.holdForUpdate(onIdle)
    await vi.advanceTimersByTimeAsync(0)
    expect(onIdle).toHaveBeenCalledTimes(1)
    busy = true
    expect(restart.rearmHold()).toBe(true)
    await vi.advanceTimersByTimeAsync(UPDATE_HOLD_RECHECK_MS)
    expect(onIdle).toHaveBeenCalledTimes(1)
    busy = false
    await vi.advanceTimersByTimeAsync(UPDATE_HOLD_RECHECK_MS)
    expect(onIdle).toHaveBeenCalledTimes(2)
    restart.releaseHold()
    expect(restart.rearmHold()).toBe(false)
  })

  it('segunda retenção é ignorada; erro no onIdle vai ao host e não derruba o coordenador', async () => {
    const restart = coordinator()
    restart.register('c1', () => ({ busy: false }))
    const first = vi.fn(() => {
      throw new Error('instalador falhou')
    })
    const second = vi.fn()
    restart.holdForUpdate(first)
    restart.holdForUpdate(second)
    await vi.advanceTimersByTimeAsync(0)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(reports).toEqual(['Atualização agendada: instalador falhou'])
    expect(restart.updateHold).toBe(true)
  })
})
