import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyGpuMode, BOOT_WINDOW_MS, createGpuCrashHandler, GPU_MODE_FILE, LATE_CRASHES, readGpuMode } from './gpuSafeMode'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gpu-mode-'))
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const fakeApp = () => ({ commandLine: { appendSwitch: vi.fn() }, disableHardwareAcceleration: vi.fn() })
const gpu = (reason = 'crashed') => ({ type: 'GPU', reason })

describe('modo seguro da GPU', () => {
  it('sem arquivo (ou corrompido): abre normal, sem chave nenhuma', () => {
    const app = fakeApp()
    expect(applyGpuMode(app, dir).level).toBe(0)
    writeFileSync(join(dir, GPU_MODE_FILE), '{lixo')
    expect(readGpuMode(dir).level).toBe(0)
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled()
    expect(app.disableHardwareAcceleration).not.toHaveBeenCalled()
  })

  it('nível 1 tira o sandbox da GPU; nível 2 também desliga a aceleração', () => {
    writeFileSync(join(dir, GPU_MODE_FILE), JSON.stringify({ level: 1 }))
    const a1 = fakeApp()
    applyGpuMode(a1, dir)
    expect(a1.commandLine.appendSwitch).toHaveBeenCalledWith('disable-gpu-sandbox')
    expect(a1.disableHardwareAcceleration).not.toHaveBeenCalled()
    writeFileSync(join(dir, GPU_MODE_FILE), JSON.stringify({ level: 2 }))
    const a2 = fakeApp()
    applyGpuMode(a2, dir)
    expect(a2.disableHardwareAcceleration).toHaveBeenCalled()
  })

  it('1ª queda na abertura grava o nível; a 2ª reinicia o app uma vez só', () => {
    const relaunch = vi.fn()
    const t = 1_000
    const onGone = createGpuCrashHandler({ dir, state: { level: 0 }, startedAt: t, now: () => t + 2_000, relaunch })
    onGone(gpu('launch-failed'))
    expect(readGpuMode(dir)).toMatchObject({ level: 1, reason: 'launch-failed' })
    expect(relaunch).not.toHaveBeenCalled()
    onGone(gpu())
    onGone(gpu())
    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(readGpuMode(dir).level).toBe(1)
  })

  it('ignora outros processos e saída normal', () => {
    const relaunch = vi.fn()
    const onGone = createGpuCrashHandler({ dir, state: { level: 0 }, startedAt: 0, now: () => 10, relaunch })
    onGone({ type: 'Utility', reason: 'crashed' })
    onGone(gpu('clean-exit'))
    onGone(gpu('killed'))
    expect(readGpuMode(dir).level).toBe(0)
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('já no teto: não reinicia em loop', () => {
    const relaunch = vi.fn()
    const onGone = createGpuCrashHandler({ dir, state: { level: 2 }, startedAt: 0, now: () => 10, relaunch })
    for (let i = 0; i < 5; i++) onGone(gpu())
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('depois da abertura, só várias quedas seguidas sobem o nível (vale na próxima abertura)', () => {
    let now = BOOT_WINDOW_MS + 10_000
    const relaunch = vi.fn()
    const onGone = createGpuCrashHandler({ dir, state: { level: 0 }, startedAt: 0, now: () => now, relaunch })
    for (let i = 0; i < LATE_CRASHES - 1; i++) {
      onGone(gpu())
      now += 1_000
    }
    expect(readGpuMode(dir).level).toBe(0)
    onGone(gpu())
    expect(readGpuMode(dir).level).toBe(1)
    expect(relaunch).not.toHaveBeenCalled()
  })
})
