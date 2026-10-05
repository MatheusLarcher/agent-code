import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundTask } from '@shared/ipc'
import { canResumeQueue, createBackgroundHold, hasAgentBackground, isAgentTask, type QueueResumeState } from './backgroundHold'

const agent: BackgroundTask = { id: 'a1', type: 'local_agent', description: 'revisor' }
const shell: BackgroundTask = { id: 'b1', type: 'local_bash', description: 'npm run dev' }

describe('backgroundHold — o que segura a fila', () => {
  it('só subagente segura; shell/servidor em segundo plano não', () => {
    expect(isAgentTask(agent)).toBe(true)
    expect(isAgentTask({ type: 'remote_agent' })).toBe(true)
    expect(isAgentTask(shell)).toBe(false)
    expect(hasAgentBackground([shell])).toBe(false)
    expect(hasAgentBackground([shell, agent])).toBe(true)
    expect(hasAgentBackground(undefined)).toBe(false)
  })

  it('canResumeQueue: livre e com o que fazer; qualquer trava segura', () => {
    const free: QueueResumeState = {
      exists: true,
      busy: false,
      inflight: false,
      stopping: false,
      handoffPending: false,
      recovery: false,
      agentBackground: false,
      work: true
    }
    expect(canResumeQueue(free)).toBe(true)
    for (const key of ['busy', 'inflight', 'stopping', 'handoffPending', 'recovery', 'agentBackground'] as const) {
      expect(canResumeQueue({ ...free, [key]: true })).toBe(false)
    }
    expect(canResumeQueue({ ...free, work: false })).toBe(false)
    expect(canResumeQueue({ ...free, exists: false })).toBe(false)
  })
})

describe('backgroundHold — retomada depois do último subagente', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup(ready = (): boolean => true) {
    const ends: Array<() => void> = []
    const waitTurnEnd = vi.fn(() => new Promise<void>((resolve) => ends.push(resolve)))
    const run = vi.fn(async () => undefined)
    const hold = createBackgroundHold({ settleMs: 1_500, waitTurnEnd, fallbackMs: 60_000, ready: vi.fn(ready), run })
    const endTurn = async (): Promise<void> => {
      ends.shift()?.()
      await vi.advanceTimersByTimeAsync(0)
    }
    return { hold, waitTurnEnd, run, endTurn }
  }

  it('intervalo, depois o fim real do turno no main, e só então despacha — uma vez', async () => {
    const { hold, waitTurnEnd, run, endTurn } = setup()
    hold.update('c1', [agent])
    expect(hold.holds('c1')).toBe(true)
    expect(hold.pending('c1')).toBe(false)
    hold.update('c1', [shell])
    expect(hold.holds('c1')).toBe(false)
    expect(hold.pending('c1')).toBe(true)
    await vi.advanceTimersByTimeAsync(1_499)
    expect(waitTurnEnd).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(waitTurnEnd).toHaveBeenCalledWith('c1')
    expect(run).not.toHaveBeenCalled()
    await endTurn()
    expect(run).toHaveBeenCalledTimes(1)
    expect(hold.pending('c1')).toBe(false)
    // Outro snapshot sem subagente (já não segurava): nada agendado de novo.
    hold.update('c1', [])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('conversa ocupada na conferência (o CLI abriu o turno de notificação): não despacha', async () => {
    let free = false
    const { hold, run, endTurn } = setup(() => free)
    hold.update('c1', [agent])
    hold.update('c1', [])
    await vi.advanceTimersByTimeAsync(1_500)
    await endTurn()
    expect(run).not.toHaveBeenCalled()
    free = true
    expect(run).not.toHaveBeenCalled()
  })

  it('subagente novo no intervalo cancela a retomada; snapshots repetidos não duplicam o despacho', async () => {
    const { hold, waitTurnEnd, run, endTurn } = setup()
    hold.update('c1', [agent])
    hold.update('c1', [])
    hold.update('c1', [agent]) // outro subagente subiu antes do intervalo acabar
    await vi.advanceTimersByTimeAsync(3_000)
    expect(waitTurnEnd).not.toHaveBeenCalled()
    hold.update('c1', [])
    hold.schedule('c1') // fila restaurada agendando junto: a onda nova supera a anterior
    await vi.advanceTimersByTimeAsync(1_500)
    expect(waitTurnEnd).toHaveBeenCalledTimes(1)
    await endTurn()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('onda superada enquanto esperava o main não despacha; só a última', async () => {
    const { hold, waitTurnEnd, run, endTurn } = setup()
    hold.schedule('c1')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(waitTurnEnd).toHaveBeenCalledTimes(1)
    hold.schedule('c1')
    await endTurn() // a primeira onda volta, já superada
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_500)
    await endTurn()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('sessão morta com subagente: o snapshot sai e a fila retoma', async () => {
    const { hold, run, endTurn } = setup()
    hold.update('c1', [agent])
    hold.clear('c1')
    expect(hold.holds('c1')).toBe(false)
    await vi.advanceTimersByTimeAsync(1_500)
    await endTurn()
    expect(run).toHaveBeenCalledTimes(1)
    hold.clear('c1') // nada segurava: nada agendado
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('main sem o canal: segue depois do intervalo; dispose cancela o agendado', async () => {
    const run = vi.fn(async () => undefined)
    const hold = createBackgroundHold({ settleMs: 1_500, waitTurnEnd: () => undefined, fallbackMs: 60_000, ready: () => true, run })
    hold.schedule('c1')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(run).toHaveBeenCalledTimes(1)
    hold.schedule('c1')
    hold.dispose()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(hold.pending('c1')).toBe(false)
  })
})
