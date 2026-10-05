import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FreezeRecord } from '@shared/ipc'
import { BATCH_MS, flushFreezes, startFreezeWatch } from './freezeWatch'
import { fakeProfiler, sampleTrace } from './fakeProfiler'

let stop: (() => void) | null = null
const logFreezes = vi.fn<(batch: FreezeRecord[]) => void>()
const ctx = { tab: 'chat', convId: 'conv-1', busy: 1 }
const sent = (): FreezeRecord[] => logFreezes.mock.calls.flatMap(([batch]) => batch)

/** PerformanceObserver falso com long-animation-frame; devolve o entregador de quadros. */
function fakeLoaf(): (entries: unknown[]) => void {
  let callback: ((list: { getEntries: () => unknown[] }) => void) | null = null
  class FakeObserver {
    static supportedEntryTypes = ['long-animation-frame']
    constructor(cb: (list: { getEntries: () => unknown[] }) => void) {
      callback = cb
    }
    observe = vi.fn()
    disconnect = vi.fn()
  }
  vi.stubGlobal('PerformanceObserver', FakeObserver)
  return (entries) => callback?.({ getEntries: () => entries })
}

// Quadro [100, 220.4] — cobre as amostras de 100 a 170 do sampleTrace.
const FRAME = { startTime: 100, duration: 120.4, blockingDuration: 30, styleAndLayoutStart: 155, scripts: [] }

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(performance, 'now').mockImplementation(() => 0)
  ;(window as unknown as { api: unknown }).api = { logFreezes }
  logFreezes.mockClear()
})

afterEach(() => {
  stop?.()
  stop = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('freezeWatch + JS Self-Profiling', () => {
  it('quadro sem scripts do LoAF espera o envio, o perfil gira (novo antes do antigo) e o quadro ganha scripts, jsMs e layoutMs', async () => {
    const deliver = fakeLoaf()
    const fake = fakeProfiler()
    stop = startFreezeWatch(() => ctx)
    expect(fake.log).toEqual(['novo 0'])
    fake.instances[0].trace = sampleTrace()
    deliver([FRAME])
    expect(logFreezes).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(BATCH_MS)
    expect(fake.log).toEqual(['novo 0', 'novo 1', 'parou 0'])
    const [frame] = sent()
    expect(frame).toMatchObject({ kind: 'quadro', ms: 120, blockingMs: 30, jsMs: 70, layoutMs: 65, ctx: { ...ctx, office: false } })
    expect(frame.scripts?.map((s) => [s.sourceFunctionName, s.ms])).toEqual([
      ['applyFeed', 40],
      ['(anônima)', 10],
      ['flush', 10]
    ])
    expect(frame.scripts?.[0]).toMatchObject({ invoker: 'perfil', invokerType: 'amostragem', sourceFile: 'index-abc.js', sourceLine: 1, sourceColumn: 3400, stack: 'applyFeed < flush < render' })
    expect(JSON.stringify(frame)).not.toMatch(/Fulano|Users/)
  })

  it('quadro com scripts do LoAF mantém os do LoAF e não espera atribuição', async () => {
    const deliver = fakeLoaf()
    const fake = fakeProfiler()
    stop = startFreezeWatch(() => ctx)
    fake.instances[0].trace = sampleTrace()
    deliver([{ ...FRAME, scripts: [{ duration: 60, invoker: 'TimerHandler:setTimeout', sourceURL: 'file:///a/index.js' }] }])
    await vi.advanceTimersByTimeAsync(BATCH_MS)
    expect(fake.log).toEqual(['novo 0'])
    const [frame] = sent()
    expect(frame.scripts).toEqual([{ ms: 60, invoker: 'TimerHandler:setTimeout', sourceFile: 'index.js' }])
    expect(frame).not.toHaveProperty('jsMs')
  })

  it('sem Profiler: comportamento de antes (sai no envio, sem scripts nem jsMs)', async () => {
    const deliver = fakeLoaf()
    stop = startFreezeWatch(() => ctx)
    deliver([FRAME])
    flushFreezes()
    expect(sent()).toEqual([expect.objectContaining({ kind: 'quadro', ms: 120, layoutMs: 65 })])
    expect(sent()[0]).not.toHaveProperty('scripts')
    expect(sent()[0]).not.toHaveProperty('jsMs')
  })

  it('erro no giro ou trace sem amostra no intervalo: o quadro sai sem atribuição, nunca se perde', async () => {
    const deliver = fakeLoaf()
    const fake = fakeProfiler()
    stop = startFreezeWatch(() => ctx)
    fake.instances[0].stop = () => Promise.reject(new Error('falhou'))
    deliver([FRAME])
    await vi.advanceTimersByTimeAsync(BATCH_MS)
    expect(sent()).toEqual([expect.objectContaining({ kind: 'quadro', ms: 120 })])
    expect(sent()[0]).not.toHaveProperty('scripts')
    logFreezes.mockClear()
    // O novo profiler (1) devolve trace vazio: nada a dizer sobre o quadro.
    deliver([{ ...FRAME, startTime: 5000 }])
    await vi.advanceTimersByTimeAsync(BATCH_MS)
    expect(sent()).toHaveLength(1)
    expect(sent()[0]).not.toHaveProperty('jsMs')
  })

  it('desligar para o profiler e manda o quadro à espera sem atribuição', () => {
    const deliver = fakeLoaf()
    const fake = fakeProfiler()
    stop = startFreezeWatch(() => ctx)
    deliver([FRAME])
    stop()
    stop = null
    expect(fake.log).toEqual(['novo 0', 'parou 0'])
    expect(sent()).toEqual([expect.objectContaining({ kind: 'quadro', ms: 120 })])
  })
})
