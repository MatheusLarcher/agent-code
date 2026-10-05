import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IDLE_ROTATE_MS,
  PROFILER_BUFFER,
  SAMPLE_MS,
  attributeFrame,
  jsProfilerActive,
  rotateJsProfiler,
  startJsProfiler,
  stopJsProfiler,
  type ProfilerTrace,
  type SampledTrace
} from './jsProfiler'
import { fakeProfiler, sampleTrace } from './fakeProfiler'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  stopJsProfiler()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('jsProfiler — atribuição', () => {
  it('top 3 por tempo próprio, com arquivo, posição e a pilha mais comum da folha', () => {
    const out = attributeFrame([{ trace: sampleTrace(), interval: SAMPLE_MS }], 100, 180)
    expect(out?.jsMs).toBe(70)
    expect(out?.scripts).toEqual([
      // 4 amostras: 3 em applyFeed < flush < render, 1 em applyFeed < render.
      { ms: 40, invoker: 'perfil', invokerType: 'amostragem', sourceFunctionName: 'applyFeed', sourceFile: 'index-abc.js', sourceLine: 1, sourceColumn: 3400, stack: 'applyFeed < flush < render' },
      { ms: 10, invoker: 'perfil', invokerType: 'amostragem', sourceFunctionName: '(anônima)', sourceFile: 'vendor.js', sourceLine: 5, sourceColumn: 7, stack: '(anônima) < flush < render' },
      { ms: 10, invoker: 'perfil', invokerType: 'amostragem', sourceFunctionName: 'flush', sourceFile: 'index-abc.js', sourceLine: 1, sourceColumn: 200, stack: 'flush < render' }
    ])
    expect(JSON.stringify(out)).not.toMatch(/Fulano|Users/)
  })

  it('pilha: no máximo 6 nomes e 120 caracteres', () => {
    const name = 'n'.repeat(30)
    const frames = Array.from({ length: 10 }, (_, i) => ({ name: `${name}${i}` }))
    const stacks = frames.map((_, i) => (i === 0 ? { frameId: 0 } : { frameId: i, parentId: i - 1 }))
    const trace: ProfilerTrace = { resources: [], frames, stacks, samples: [{ timestamp: 5, stackId: 9 }] }
    const [script] = attributeFrame([{ trace, interval: 10 }], 0, 10)?.scripts ?? []
    expect(script.stack?.length).toBeLessThanOrEqual(120)
    expect(script.stack?.startsWith(`${name}9 < ${name}8`)).toBe(true)
    expect(script).not.toHaveProperty('sourceFile')
    expect(script).not.toHaveProperty('sourceLine')
    const short = { resources: [], frames: frames.map((f, i) => ({ name: `f${i}` })), stacks, samples: [{ timestamp: 5, stackId: 9 }] }
    expect(attributeFrame([{ trace: short, interval: 10 }], 0, 10)?.scripts[0].stack).toBe('f9 < f8 < f7 < f6 < f5 < f4')
  })

  it('soma traces (o do giro anterior e o recém-parado) e devolve null sem amostra no intervalo', () => {
    const a: SampledTrace = { trace: sampleTrace(), interval: 10 }
    const b: SampledTrace = { trace: { ...sampleTrace(), samples: [{ timestamp: 175, stackId: 5 }, { timestamp: 178, stackId: 5 }] }, interval: 10 }
    const out = attributeFrame([a, b], 155, 180)
    // Peso = trecho até a próxima amostra, recortado ao quadro: 160→170 (10),
    // 170→180 (10), 175→178 (3) e 178→180 (2, a última vale o intervalo).
    expect(out?.jsMs).toBe(25)
    expect(out?.scripts.map((s) => [s.sourceFunctionName, s.ms])).toEqual([
      ['saveConversations', 15],
      ['applyFeed', 10]
    ])
    expect(attributeFrame([a], 1000, 1200)).toBeNull()
    expect(attributeFrame([], 0, 1e9)).toBeNull()
    // Só amostras ociosas: dá para dizer que o JS foi 0 (o resto é layout/pintura).
    expect(attributeFrame([a], 151, 159)).toEqual({ scripts: [], jsMs: 0 })
  })

  it('pesa cada amostra pelo espaçamento real (Windows ~28 ms com 16 ms informados), com teto', () => {
    const trace = { ...sampleTrace(), samples: [0, 28, 56, 84].map((timestamp) => ({ timestamp, stackId: 5 })) }
    const out = attributeFrame([{ trace, interval: 16 }], 0, 100)
    // 28 + 28 + 28 + 16 (a última vale o intervalo informado) — não 4 × 16.
    expect(out?.jsMs).toBe(100)
    const gap = { ...sampleTrace(), samples: [{ timestamp: 0, stackId: 5 }, { timestamp: 500, stackId: 5 }] }
    expect(attributeFrame([{ trace: gap, interval: 16 }], 0, 400)?.jsMs).toBe(100)
  })
})

describe('jsProfiler — ciclo de vida', () => {
  it('sem Profiler (jsdom) ou com o construtor lançando: não liga', async () => {
    expect(startJsProfiler()).toBe(false)
    expect(jsProfilerActive()).toBe(false)
    expect(await rotateJsProfiler()).toEqual([])
    fakeProfiler({ throws: true })
    expect(startJsProfiler()).toBe(false)
  })

  it('liga com 10 ms e buffer; o giro inicia o novo ANTES de parar o antigo e devolve o anterior + o parado', async () => {
    const fake = fakeProfiler()
    expect(startJsProfiler()).toBe(true)
    expect(startJsProfiler()).toBe(true)
    expect(fake.instances).toHaveLength(1)
    expect(fake.instances[0].options).toEqual({ sampleInterval: SAMPLE_MS, maxBufferSize: PROFILER_BUFFER })
    const first = await rotateJsProfiler()
    expect(fake.log).toEqual(['novo 0', 'novo 1', 'parou 0'])
    expect(first.map((t) => t.trace)).toEqual([fake.instances[0].trace])
    const second = await rotateJsProfiler()
    expect(second.map((t) => t.trace)).toEqual([fake.instances[0].trace, fake.instances[1].trace])
    stopJsProfiler()
    expect(fake.log.at(-1)).toBe('parou 2')
    expect(jsProfilerActive()).toBe(false)
  })

  it(`sem quadros, gira sozinho a cada ${IDLE_ROTATE_MS / 1000} s (descarta o trace) e para de girar ao desligar`, async () => {
    const fake = fakeProfiler()
    startJsProfiler()
    await vi.advanceTimersByTimeAsync(IDLE_ROTATE_MS - 1)
    expect(fake.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.log).toEqual(['novo 0', 'novo 1', 'parou 0'])
    stopJsProfiler()
    await vi.advanceTimersByTimeAsync(IDLE_ROTATE_MS * 3)
    expect(fake.instances).toHaveLength(2)
  })

  it('stop que falha: o giro devolve só o que tinha, sem lançar', async () => {
    const fake = fakeProfiler()
    startJsProfiler()
    fake.instances[0].stop = () => Promise.reject(new Error('x'))
    await expect(rotateJsProfiler()).resolves.toEqual([])
    expect(jsProfilerActive()).toBe(true)
  })
})
