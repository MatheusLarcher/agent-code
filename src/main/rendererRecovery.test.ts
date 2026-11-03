// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  flushScreenLog,
  initScreenLog,
  logChildProcessGone,
  sanitizeScreenLogEntry,
  watchRendererRecovery,
  type ScreenLogEntry
} from './rendererRecovery'

class FakeWindow extends EventEmitter {
  destroyed = false
  webContents = Object.assign(new EventEmitter(), {
    destroyed: false,
    reloads: 0,
    isDestroyed(this: { destroyed: boolean }) {
      return this.destroyed
    },
    reload(this: { reloads: number }) {
      this.reloads += 1
    }
  })
  isDestroyed(): boolean {
    return this.destroyed
  }
  crash(reason = 'oom', exitCode = -536870904): void {
    this.webContents.emit('render-process-gone', {}, { reason, exitCode })
  }
  loaded(): void {
    this.webContents.emit('did-finish-load')
  }
}

function setup(options: { closing?: boolean } = {}) {
  const win = new FakeWindow()
  const logs: ScreenLogEntry[] = []
  let closing = options.closing ?? false
  let clock = 0
  const onDownWhileClosing = vi.fn()
  const recovery = watchRendererRecovery(win, {
    isClosing: () => closing,
    onDownWhileClosing,
    log: (entry) => logs.push(entry),
    now: () => clock,
    freeMemoryMb: () => 512
  })
  return {
    win,
    logs,
    recovery,
    onDownWhileClosing,
    setClosing: (value: boolean) => (closing = value),
    advanceClock: (ms: number) => (clock += ms)
  }
}

const dirs: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await flushScreenLog()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('watchRendererRecovery', () => {
  it('a tela morta volta sozinha: recarrega depois de 1 s e registra motivo e memória livre', () => {
    vi.useFakeTimers()
    const { win, logs, recovery } = setup()
    win.crash('oom', -536870904)
    expect(recovery.isDown()).toBe(true)
    expect(logs[0]).toEqual({ event: 'renderer-gone', reason: 'oom', exitCode: -536870904, freeMemMb: 512 })
    expect(logs[1]).toEqual({ event: 'renderer-reload', attempt: 1, delayMs: 1_000 })
    vi.advanceTimersByTime(999)
    expect(win.webContents.reloads).toBe(0)
    vi.advanceTimersByTime(1)
    expect(win.webContents.reloads).toBe(1)
    win.loaded()
    expect(recovery.isDown()).toBe(false)
    expect(logs.at(-1)).toEqual({ event: 'renderer-recovered', attempt: 1, freeMemMb: 512 })
  })

  it('quedas seguidas esperam mais (1 s, 5 s, 30 s, 60 s) para não martelar a máquina sem memória', () => {
    vi.useFakeTimers()
    const { win, logs } = setup()
    const delays: number[] = []
    for (let i = 0; i < 5; i += 1) {
      win.crash('launch-failed', 0)
      delays.push((logs.at(-1) as ScreenLogEntry).delayMs ?? -1)
      vi.runOnlyPendingTimers()
    }
    expect(delays).toEqual([1_000, 5_000, 30_000, 60_000, 60_000])
    expect(win.webContents.reloads).toBe(5)
  })

  it('depois de um tempo estável, a próxima queda volta a esperar só 1 s', () => {
    vi.useFakeTimers()
    const { win, logs, advanceClock } = setup()
    win.crash()
    vi.runOnlyPendingTimers()
    win.crash()
    vi.runOnlyPendingTimers()
    advanceClock(6 * 60_000)
    win.crash()
    expect(logs.at(-1)).toEqual({ event: 'renderer-reload', attempt: 3, delayMs: 1_000 })
  })

  it('não recarrega durante o fechamento: avisa para concluir sem a tela', () => {
    vi.useFakeTimers()
    const { win, recovery, onDownWhileClosing } = setup({ closing: true })
    win.crash('crashed', 1)
    vi.runAllTimers()
    expect(win.webContents.reloads).toBe(0)
    expect(recovery.isDown()).toBe(true)
    expect(onDownWhileClosing).toHaveBeenCalledTimes(1)
  })

  it('fechamento pedido depois da queda: a recarga agendada é abandonada', () => {
    vi.useFakeTimers()
    const { win, setClosing } = setup()
    win.crash()
    setClosing(true)
    vi.runAllTimers()
    expect(win.webContents.reloads).toBe(0)
  })

  it('tela travada conta como fora do ar até responder, e com o X pedido conclui sem ela', () => {
    const { win, logs, recovery, onDownWhileClosing, setClosing } = setup()
    win.emit('unresponsive')
    expect(recovery.isDown()).toBe(true)
    expect(onDownWhileClosing).not.toHaveBeenCalled()
    win.emit('responsive')
    expect(recovery.isDown()).toBe(false)
    setClosing(true)
    win.emit('unresponsive')
    expect(onDownWhileClosing).toHaveBeenCalledTimes(1)
    expect(logs.map((entry) => entry.event)).toEqual(['renderer-unresponsive', 'renderer-responsive', 'renderer-unresponsive'])
  })

  it('janela destruída ou recuperação descartada: nenhuma recarga', () => {
    vi.useFakeTimers()
    const first = setup()
    first.win.crash()
    first.win.destroyed = true
    vi.runAllTimers()
    expect(first.win.webContents.reloads).toBe(0)

    const second = setup()
    second.win.crash()
    second.recovery.dispose()
    vi.runAllTimers()
    expect(second.win.webContents.reloads).toBe(0)
    expect(second.recovery.isDown()).toBe(false)
  })

  it('F5 normal (sem queda) não registra recuperação', () => {
    const { win, logs } = setup()
    win.loaded()
    expect(logs).toEqual([])
  })
})

describe('tela.log', () => {
  it('grava em <userData>/logs/tela.log só os campos conhecidos; saída limpa de processo filho não entra', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tela-log-'))
    dirs.push(dir)
    initScreenLog(dir)
    logChildProcessGone({ type: 'GPU', reason: 'crashed', exitCode: -1073741819, name: undefined })
    logChildProcessGone({ type: 'Utility', reason: 'clean-exit', exitCode: 0, name: 'voz' })
    await flushScreenLog()
    const lines = (await readFile(join(dir, 'logs', 'tela.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toEqual([
      { at: expect.any(String), event: 'process-gone', type: 'GPU', reason: 'crashed', exitCode: -1073741819, freeMemMb: expect.any(Number) }
    ])
  })

  it('descarta campo desconhecido e valor do tipo errado', () => {
    const entry = { event: 'renderer-gone', reason: 'oom', exitCode: Number.NaN, segredo: 'x', attempt: '2' } as unknown as ScreenLogEntry
    expect(sanitizeScreenLogEntry(entry)).toEqual({ event: 'renderer-gone', reason: 'oom' })
  })
})
