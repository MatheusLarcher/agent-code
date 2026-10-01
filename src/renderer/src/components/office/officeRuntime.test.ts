import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOfficeArt } from '../../office/art'
import type { OfficeRenderer } from '../../office/engine'
import { officeStore } from '../../office/officeStore'
import type { UIMessage } from '../../types'
import { syntheticFeed } from './devFeed'
import { getOfficeRuntime, resetOfficeRuntime, withOwnerActivity } from './officeRuntime'
import { FPS_CAP } from './officeView'

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => stubCtx() as never)
})

afterEach(() => {
  vi.restoreAllMocks()
  officeStore.setOverride(null)
  resetOfficeRuntime()
})

/** Contexto 2D que só conta chamadas (o jsdom não tem canvas). */
function stubCtx(): CanvasRenderingContext2D {
  const noop = (): void => {}
  return new Proxy({} as CanvasRenderingContext2D, {
    get: (t, k) => (k in t ? (t as never)[k] : noop),
    set: (t, k, v) => (((t as unknown as Record<string | symbol, unknown>)[k] = v), true)
  })
}

describe('officeRuntime', () => {
  it('monitor da mesa passa a "read" quando o dono está lendo', () => {
    officeStore.setOverride(syntheticFeed())
    const rt = getOfficeRuntime()
    const ch = [...rt.state.characters.values()].find((c) => c.seatId && rt.state.seats.get(c.seatId)?.deskUid)!
    const deskUid = rt.state.seats.get(ch.seatId!)!.deskUid!
    const desk = rt.state.layout.furniture.find((f) => f.uid === deskUid)!
    ch.isActive = true
    ch.activity = 'read'
    rt.state.time += 1
    const base = createOfficeArt()
    const art = withOwnerActivity(base, rt.state)
    const reading = art.furnitureSprite(desk, { active: true, t: rt.state.time })
    const typing = base.furnitureSprite(desk, { active: true, t: rt.state.time })
    expect(reading).not.toBe(typing)
    ch.activity = 'type'
    rt.state.time += 1
    expect(art.furnitureSprite(desk, { active: true, t: rt.state.time })).toBe(base.furnitureSprite(desk, { active: true, t: rt.state.time }))
  })

  it('mede o custo de JS por quadro com 5 salas e 20 personagens', () => {
    officeStore.setOverride(syntheticFeed())
    const rt = getOfficeRuntime()
    expect(rt.model.rooms).toHaveLength(5)
    expect(rt.model.characters.length).toBeGreaterThanOrEqual(20)
    const ctx = stubCtx()
    const renderer: OfficeRenderer = rt.renderer
    const frames = 300
    // Aquece (fundo estático e cache de sprites).
    for (let i = 0; i < 30; i++) {
      rt.state.update(1 / FPS_CAP)
      renderer.render(ctx, 1200, 800, rt.state, { zoom: 3, panX: 0, panY: 0 })
    }
    const t0 = performance.now()
    for (let i = 0; i < frames; i++) {
      rt.state.update(1 / FPS_CAP)
      renderer.render(ctx, 1200, 800, rt.state, { zoom: 3, panX: 0, panY: 0 })
    }
    const ms = (performance.now() - t0) / frames
    const cpu = (ms * FPS_CAP) / 10
    console.info(`[office-perf] ${ms.toFixed(3)} ms/quadro de JS (sem rasterizar) → ~${cpu.toFixed(2)}% de um núcleo a ${FPS_CAP} fps`)
    expect(ms).toBeLessThan(5)
  })

  it('F4·4-5: com impressoras, pilhas, ondas, café e crachá ligados, o quadro fica abaixo de 5% de um núcleo', () => {
    const base = syntheticFeed()
    officeStore.setOverride(base)
    const rt = getOfficeRuntime()
    // Todas as conversas: estouro de limite (café), troca de conta (crachá) e
    // a primeira lendo em voz (ondas). Impressora e pilha já vêm do devFeed.
    const conversations = base.conversations.map((c, i) => ({
      ...c,
      messages: [
        { kind: 'assistant-text', id: `m-${c.id}`, text: 'oi', final: true },
        { kind: 'error', id: `e-${c.id}`, text: 'limite', usageExhausted: true },
        ...(i % 3 === 0 ? [{ kind: 'account-switch', id: `s-${c.id}`, reason: 'manual', toAccountId: 'b', text: 'Troquei para a conta B (1% usado).' } as UIMessage] : [])
      ] as UIMessage[]
    }))
    officeStore.setOverride({ ...base, conversations, speakingId: `m-${conversations[0].id}` })
    expect([...rt.overlays.printers.values()].reduce((a, b) => a + b, 0)).toBe(5)
    expect(rt.overlays.piles.size).toBe(5)
    const ctx = stubCtx()
    for (let i = 0; i < 30; i++) {
      rt.state.update(1 / FPS_CAP)
      rt.renderer.render(ctx, 1200, 800, rt.state, { zoom: 3, panX: 0, panY: 0 })
    }
    expect([...rt.state.characters.values()].some((c) => c.prop === 'xicara')).toBe(true)
    const frames = 300
    const t0 = performance.now()
    for (let i = 0; i < frames; i++) {
      rt.state.update(1 / FPS_CAP)
      rt.renderer.render(ctx, 1200, 800, rt.state, { zoom: 3, panX: 0, panY: 0 })
    }
    const ms = (performance.now() - t0) / frames
    const cpu = (ms * FPS_CAP) / 10
    console.info(`[office-perf F4·4-5] ${ms.toFixed(3)} ms/quadro (update+render, canvas falso) → ~${cpu.toFixed(2)}% de um núcleo a ${FPS_CAP} fps`)
    expect(cpu).toBeLessThan(5)
  })
})
