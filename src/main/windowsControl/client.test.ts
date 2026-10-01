// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

const spawned: FakeChild[] = []
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = new FakeChild()
    spawned.push(child)
    return child
  })
}))

const { WindowsControlClient, DEFAULT_REQUEST_TIMEOUT_MS } = await import('./client')

describe('WindowsControlClient', () => {
  beforeEach(() => {
    spawned.length = 0
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('usa 45 s por padrão e encerra o helper ao estourar', async () => {
    const client = new WindowsControlClient(() => 'helper.exe')
    const pending = client.request('list_windows')
    const settled = vi.fn()
    pending.then(settled, settled)
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(45_000)
    await vi.advanceTimersByTimeAsync(44_999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).rejects.toThrow('tempo limite em list_windows')
    expect(spawned[0].killed).toBe(true)
  })

  it('respeita o timeout informado por requisição', async () => {
    const client = new WindowsControlClient(() => 'helper.exe')
    const pending = client.request('run_steps', { windowId: '1', steps: [] }, undefined, { timeoutMs: 135_000 })
    const settled = vi.fn()
    pending.then(settled, settled)
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(135_000 - DEFAULT_REQUEST_TIMEOUT_MS)
    await expect(pending).rejects.toThrow('tempo limite em run_steps')
  })

  it('resolve com a resposta do helper antes do timeout', async () => {
    const client = new WindowsControlClient(() => 'helper.exe')
    const pending = client.request<{ ok: boolean }>('run_steps', { windowId: '1' }, undefined, { timeoutMs: 135_000 })
    const line = await new Promise<string>((resolve) => spawned[0].stdin.once('data', (chunk: Buffer) => resolve(chunk.toString())))
    const { id, method, params } = JSON.parse(line) as { id: string; method: string; params: unknown }
    expect({ method, params }).toEqual({ method: 'run_steps', params: { windowId: '1' } })
    spawned[0].stdout.write(`${JSON.stringify({ id, result: { ok: true } })}\n`)
    await expect(pending).resolves.toEqual({ ok: true })
  })
})
