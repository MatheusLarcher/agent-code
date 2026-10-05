import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FreezeRecord } from '@shared/ipc'
import {
  BATCH_MAX,
  BATCH_MS,
  flushFreezes,
  freezeSection,
  markConversationSwitch,
  markPaneSwitch,
  markSwitch,
  scriptFileName,
  setOfficeMounted,
  startFreezeWatch,
  timeSave
} from './freezeWatch'

let clock = 0
let stop: (() => void) | null = null
const logFreezes = vi.fn<(batch: FreezeRecord[]) => void>()
const ctx = { tab: 'chat', convId: 'conv-1', busy: 2, remote: true }
const sent = (): FreezeRecord[] => logFreezes.mock.calls.flatMap(([batch]) => batch)

beforeEach(() => {
  vi.useFakeTimers()
  clock = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(clock), 16))
  ;(window as unknown as { api: unknown }).api = { logFreezes }
  logFreezes.mockClear()
})

afterEach(() => {
  stop?.()
  stop = null
  setOfficeMounted(false)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** PerformanceObserver falso: guarda o callback para o teste entregar quadros. */
function fakeObserver(types: string[]): { deliver: (entries: unknown[]) => void; observe: ReturnType<typeof vi.fn>; created: () => number } {
  let callback: ((list: { getEntries: () => unknown[] }) => void) | null = null
  let created = 0
  const observe = vi.fn()
  class FakeObserver {
    static supportedEntryTypes = types
    constructor(cb: (list: { getEntries: () => unknown[] }) => void) {
      callback = cb
      created++
    }
    observe = observe
    disconnect = vi.fn()
  }
  vi.stubGlobal('PerformanceObserver', FakeObserver)
  return { deliver: (entries) => callback?.({ getEntries: () => entries }), observe, created: () => created }
}

describe('freezeWatch — quadros longos (long-animation-frame)', () => {
  it('sem suporte (jsdom) é no-op: nenhum observer, nada enviado', () => {
    const fake = fakeObserver(['longtask', 'paint'])
    stop = startFreezeWatch(() => ctx)
    expect(fake.created()).toBe(0)
    vi.advanceTimersByTime(BATCH_MS * 2)
    expect(logFreezes).not.toHaveBeenCalled()
    stop()
    stop = null
    vi.unstubAllGlobals()
    vi.stubGlobal('PerformanceObserver', undefined)
    expect(() => (stop = startFreezeWatch(() => ctx))).not.toThrow()
  })

  it('com suporte: observa buffered e registra só quadro > 100 ms, com até 3 scripts e o contexto', () => {
    const fake = fakeObserver(['long-animation-frame'])
    stop = startFreezeWatch(() => ctx)
    setOfficeMounted(true)
    expect(fake.observe).toHaveBeenCalledWith({ type: 'long-animation-frame', buffered: true })
    const script = (duration: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      duration,
      invoker: 'TimerHandler:setTimeout',
      invokerType: 'user-callback',
      sourceFunctionName: 'f'.repeat(200),
      sourceURL: 'file:///C:/Users/Fulano/app/out/renderer/assets/index-abc.js?v=1#x',
      sourceCharPosition: 1234,
      ...extra
    })
    fake.deliver([
      { startTime: 10, duration: 100, blockingDuration: 50, scripts: [] },
      { startTime: 20, duration: 180.4, blockingDuration: 130.6, scripts: [script(5), script(90), script(20), script(60), script(1)] }
    ])
    flushFreezes()
    const records = sent()
    expect(records).toHaveLength(1)
    const [frame] = records
    expect(frame).toMatchObject({ kind: 'quadro', ms: 180, blockingMs: 131, ctx: { ...ctx, office: true } })
    expect(Number.isFinite(frame.at)).toBe(true)
    expect(frame.scripts?.map((s) => s.ms)).toEqual([90, 60, 20])
    expect(frame.scripts?.[0]).toEqual({
      ms: 90,
      invoker: 'TimerHandler:setTimeout',
      invokerType: 'user-callback',
      sourceFunctionName: 'f'.repeat(80),
      sourceFile: 'index-abc.js',
      sourceCharPosition: 1234
    })
    expect(JSON.stringify(records)).not.toMatch(/Fulano|Users/)
  })

  it('scriptFileName tira pasta, query e hash (/ e \\)', () => {
    expect(scriptFileName('C:\\x\\y\\chunk.js')).toBe('chunk.js')
    expect(scriptFileName('https://h/a/b.js?q=1#h')).toBe('b.js')
    expect(scriptFileName('')).toBeUndefined()
    expect(scriptFileName(undefined)).toBeUndefined()
  })
})

describe('freezeWatch — trechos (> 50 ms)', () => {
  it('50 ms não registra; 51 ms registra com o rótulo', () => {
    stop = startFreezeWatch(() => ctx)
    clock = 1000
    freezeSection('celular', 950)
    freezeSection('escritorio', 949)
    flushFreezes()
    expect(sent()).toEqual([expect.objectContaining({ kind: 'trecho', label: 'escritorio', ms: 51, ctx: { ...ctx, office: false } })])
  })

  it('salvamento: mede a parte síncrona e anota conversas e MB quando a Promise resolve', async () => {
    stop = startFreezeWatch(() => ctx)
    const stats = { processed: 3, bytes: 2 * 1024 * 1024 }
    const saving = Promise.resolve(stats)
    const out = timeSave(() => {
      clock += 60
      return saving
    })
    expect(out).toBe(saving)
    await out
    // Abaixo do limiar: nada.
    await timeSave(() => {
      clock += 50
      return Promise.resolve(stats)
    })
    flushFreezes()
    expect(sent()).toEqual([expect.objectContaining({ kind: 'trecho', label: 'salvamento', ms: 60, conversations: 3, mb: 2 })])
  })

  it('salvamento que falha: o erro continua com quem chamou e o trecho é registrado sem números', async () => {
    stop = startFreezeWatch(() => ctx)
    const out = timeSave(() => {
      clock += 70
      return Promise.reject(new Error('banco caiu'))
    })
    await expect(out).rejects.toThrow('banco caiu')
    await Promise.resolve()
    flushFreezes()
    const [record] = sent()
    expect(record).toMatchObject({ kind: 'trecho', label: 'salvamento', ms: 70 })
    expect(record).not.toHaveProperty('conversations')
  })

  it('sem startFreezeWatch nada é juntado', () => {
    clock = 500
    freezeSection('celular', 0)
    flushFreezes()
    expect(logFreezes).not.toHaveBeenCalled()
  })
})

describe('freezeWatch — trocas (> 150 ms até a próxima pintura)', () => {
  it('150 ms não registra; 151 ms registra o alvo', () => {
    stop = startFreezeWatch(() => ctx)
    markSwitch('aba')
    clock = 150
    vi.advanceTimersByTime(20)
    markSwitch('conversa')
    clock = 150 + 151
    vi.advanceTimersByTime(20)
    flushFreezes()
    expect(sent()).toEqual([expect.objectContaining({ kind: 'troca', target: 'conversa', ms: 151 })])
  })

  it('conversa: clicar na já aberta não registra; abrir outra registra', () => {
    stop = startFreezeWatch(() => ctx)
    markConversationSwitch('conv-1', 'conv-1')
    clock = 400
    vi.advanceTimersByTime(20)
    flushFreezes()
    expect(logFreezes).not.toHaveBeenCalled()
    markConversationSwitch('conv-1', 'conv-2')
    clock = 400 + 200
    vi.advanceTimersByTime(20)
    flushFreezes()
    expect(sent()).toEqual([expect.objectContaining({ kind: 'troca', target: 'conversa', ms: 200 })])
  })

  it('conversa: sem nenhuma aberta (null), abrir uma registra', () => {
    stop = startFreezeWatch(() => ctx)
    markConversationSwitch(null, 'conv-1')
    clock = 200
    vi.advanceTimersByTime(20)
    flushFreezes()
    expect(sent()).toEqual([expect.objectContaining({ target: 'conversa' })])
  })

  it('painel: pedir o já visível não registra; outro painel ou o recolhido registra', () => {
    stop = startFreezeWatch(() => ctx)
    markPaneSwitch('board', false, 'board')
    clock = 400
    vi.advanceTimersByTime(20)
    flushFreezes()
    expect(logFreezes).not.toHaveBeenCalled()
    markPaneSwitch('board', false, 'browser')
    clock = 400 + 200
    vi.advanceTimersByTime(20)
    markPaneSwitch('board', true, 'board')
    clock = 600 + 300
    vi.advanceTimersByTime(20)
    flushFreezes()
    expect(sent()).toEqual([
      expect.objectContaining({ kind: 'troca', target: 'painel', ms: 200 }),
      expect.objectContaining({ kind: 'troca', target: 'painel', ms: 300 })
    ])
  })

  it('uma medição por vez: a 1ª troca vence', () => {
    stop = startFreezeWatch(() => ctx)
    markSwitch('painel')
    markSwitch('aba')
    clock = 400
    vi.advanceTimersByTime(20)
    flushFreezes()
    expect(sent()).toEqual([expect.objectContaining({ target: 'painel', ms: 400 })])
  })
})

describe('freezeWatch — envio em lote', () => {
  it('junta e manda depois de ~5 s', () => {
    stop = startFreezeWatch(() => ctx)
    clock = 100
    freezeSection('celular', 0)
    freezeSection('escritorio', 0)
    vi.advanceTimersByTime(BATCH_MS - 1)
    expect(logFreezes).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(logFreezes).toHaveBeenCalledTimes(1)
    expect(logFreezes.mock.calls[0][0]).toHaveLength(2)
  })

  it('manda na hora ao juntar 20 registros', () => {
    stop = startFreezeWatch(() => ctx)
    clock = 100
    for (let i = 0; i < BATCH_MAX - 1; i++) freezeSection('celular', 0)
    expect(logFreezes).not.toHaveBeenCalled()
    freezeSection('celular', 0)
    expect(logFreezes).toHaveBeenCalledTimes(1)
    expect(logFreezes.mock.calls[0][0]).toHaveLength(BATCH_MAX)
    vi.advanceTimersByTime(BATCH_MS)
    expect(logFreezes).toHaveBeenCalledTimes(1)
  })

  it('window.api sem logFreezes (mocks antigos) não lança', () => {
    ;(window as unknown as { api: unknown }).api = {}
    stop = startFreezeWatch(() => ctx)
    clock = 100
    freezeSection('celular', 0)
    expect(() => vi.advanceTimersByTime(BATCH_MS)).not.toThrow()
  })

  it('desligar manda o que sobrou', () => {
    stop = startFreezeWatch(() => ctx)
    clock = 100
    freezeSection('celular', 0)
    stop()
    stop = null
    expect(logFreezes).toHaveBeenCalledTimes(1)
  })
})
