import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MockupCaptureResult } from '@shared/officeMockup'
import type { HtmlWrite } from './agentHtml'
import { HtmlCaptures, RECAPTURE_MS } from './htmlCaptures'

const w = (id: string, path = 'C:\\p\\a.html'): HtmlWrite => ({ id, convId: 'c', key: 'conv:c', path, ok: true })
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function setup() {
  const made: Array<{ close: ReturnType<typeof vi.fn> }> = []
  vi.stubGlobal('createImageBitmap', vi.fn(async () => {
    const b = { width: 1280, height: 640, close: vi.fn() }
    made.push(b)
    return b as unknown as ImageBitmap
  }))
  const pending: Array<(r: MockupCaptureResult) => void> = []
  const api = { officeMockupCapture: vi.fn(() => new Promise<MockupCaptureResult>((r) => pending.push(r))) }
  let now = 0
  const ready = vi.fn()
  const c = new HtmlCaptures(api, ready, () => now)
  const ok: MockupCaptureResult = { ok: true, url: 'agent-mockup://t/a.html', png: new Uint8Array([1]) }
  return { c, api, made, pending, ready, ok, advance: (ms: number) => void (now += ms) }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('as capturas do HTML para a TV (HtmlCaptures)', () => {
  it('pede uma vez por escrita; pendente → bitmap; a escrita anterior fecha o bitmap; captura atrasada de outra escrita é descartada', async () => {
    const s = setup()
    s.c.want(w('w1'), 'C:\\p')
    s.c.want(w('w1'), 'C:\\p')
    expect(s.api.officeMockupCapture).toHaveBeenCalledTimes(1)
    expect(s.api.officeMockupCapture).toHaveBeenCalledWith({ cwd: 'C:\\p', path: 'C:\\p\\a.html' })
    expect(s.c.image('w1')).toBeNull()
    s.pending[0](s.ok)
    await flush()
    expect(s.c.image('w1')).toBe(s.made[0])
    expect(s.ready).toHaveBeenCalledTimes(1)
    // Outro arquivo: pede já; o bitmap de w1 fecha.
    s.c.want(w('w2', 'C:\\p\\b.html'), 'C:\\p')
    expect(s.made[0].close).toHaveBeenCalledTimes(1)
    s.c.want(w('w3', 'C:\\p\\c.html'), 'C:\\p')
    s.pending[1](s.ok) // chegou a de w2, mas a TV já quer w3
    await flush()
    expect(s.c.image('w2')).toBeNull()
    expect(s.made).toHaveLength(1) // nem decodifica
    s.pending[2]({ ok: false, error: 'tempo esgotado' })
    await flush()
    expect(s.c.image('w3')).toBe('failed')
  })

  it(`o mesmo arquivo editado de novo espera RECAPTURE_MS (a última edição manda); clear e dispose fecham o bitmap`, async () => {
    vi.useFakeTimers()
    const s = setup()
    s.c.want(w('e1'), 'C:\\p')
    s.pending[0](s.ok)
    await flush()
    s.c.want(w('e2'), 'C:\\p')
    s.c.want(w('e3'), 'C:\\p')
    expect(s.api.officeMockupCapture).toHaveBeenCalledTimes(1)
    s.advance(RECAPTURE_MS)
    await vi.advanceTimersByTimeAsync(RECAPTURE_MS)
    expect(s.api.officeMockupCapture).toHaveBeenCalledTimes(2)
    s.pending[1](s.ok)
    await flush()
    expect(s.c.image('e3')).toBe(s.made[1])
    s.c.clear()
    expect(s.made[1].close).toHaveBeenCalledTimes(1)
    s.c.want(w('e4', 'C:\\p\\outro.html'), 'C:\\p')
    s.c.dispose()
    s.pending[2](s.ok)
    await flush()
    expect(s.made).toHaveLength(2)
  })

  it('fora do app (sem window.api) a TV fica no esqueleto', () => {
    const c = new HtmlCaptures(null, () => {})
    c.want(w('x'), 'C:\\p')
    expect(c.image('x')).toBe('failed')
  })
})
