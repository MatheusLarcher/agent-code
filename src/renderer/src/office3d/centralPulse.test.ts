import { Group } from 'three'
import { describe, expect, it, vi } from 'vitest'
import type { CentralRequestEntry } from '@shared/central'
import { deriveOfficeModel } from '../office/adapter/model'
import { conv, feed } from '../office/adapter/testFeed'
import { CentralPulses, deliveredOf, PULSE_SPEED, PulseTracker, pulsePath, pulseTarget } from './centralPulse'
import { layoutOffice } from './layout'
import { CONSOLE, DOOR, ISLANDS } from './officePlan'

const NOW = 1_800_000_000_000
const entry = (id: string, state: CentralRequestEntry['state'], target: NonNullable<CentralRequestEntry['route']>['target'], anchor?: string): CentralRequestEntry =>
  ({ kind: 'request', id, ts: NOW, text: 'x', state, route: { target, why: '' }, ...(anchor ? { anchor: { convId: anchor, msgId: 'm' } } : {}) }) as CentralRequestEntry
const central = (entries: CentralRequestEntry[]) => conv('central', { mode: 'central', cwd: '', central: { entries } as never, updatedAt: NOW })
const toA = { kind: 'conversation' as const, convId: 'a', cwd: 'C:\\proj\\alpha', project: 'alpha', title: 'a', sandbox: false }

describe('o pulso de despacho da Central', () => {
  it('deliveredOf: só as entregues, com a conversa de destino; o tracker não pulsa o histórico', () => {
    const f = feed({ conversations: [central([entry('e1', 'delivered', toA), entry('e2', 'routing', toA), entry('e3', 'delivered', { kind: 'new-sandbox' })])] })
    expect(deliveredOf(f).map((d) => [d.id, d.target.kind, d.convId])).toEqual([['e1', 'conversation', 'a'], ['e3', 'new-sandbox', null]])
    const t = new PulseTracker()
    expect(t.update(deliveredOf(f))).toEqual([])
    const g = feed({ conversations: [central([entry('e1', 'delivered', toA), entry('e2', 'delivered', toA), entry('e3', 'delivered', { kind: 'new-sandbox' })])] })
    expect(t.update(deliveredOf(g)).map((d) => d.id)).toEqual(['e2'])
  })

  it('o destino: a mesa do principal (pela trilha da ilha dele); conversa nova na ilha do projeto ou na porta; sandbox na porta', () => {
    const f = feed({ conversations: [conv('a', { updatedAt: NOW })] })
    const layout = layoutOffice(deriveOfficeModel(f, NOW))
    const a = layout.characters.find((c) => c.key === 'conv:a')!
    const desk = layout.rooms[0].desks[a.deskIndex!]
    const t = pulseTarget({ id: 'x', target: toA, convId: 'a' }, layout)
    expect(t).toEqual({ x: desk.x, z: desk.z, island: desk.island })
    const path = pulsePath(t)
    expect(path.slice(-2)).toEqual([desk.x, desk.z])
    // Sai da borda do console, na direção da ilha.
    expect(Math.hypot(path[0] - CONSOLE.x, path[1] - CONSOLE.z)).toBeCloseTo(CONSOLE.r)
    const isl = ISLANDS[desk.island]
    expect(Math.sign(path[2] - CONSOLE.x)).toBe(Math.sign(isl.x - CONSOLE.x))
    const island = pulseTarget({ id: 'y', target: { kind: 'new-conversation', cwd: 'C:\\proj\\alpha', project: 'alpha' }, convId: null }, layout)
    expect(island.island).toBe(desk.island)
    const noIsland = pulseTarget({ id: 'z', target: { kind: 'new-conversation', cwd: 'C:\\outro', project: 'outro' }, convId: null }, layout)
    expect([noIsland.island, noIsland.z]).toEqual([null, DOOR.z])
    expect(pulseTarget({ id: 'w', target: { kind: 'new-sandbox' }, convId: null }, layout).island).toBeNull()
  })

  it('a demonstração despacha 3 vezes por loop (conversa, projeto novo, sandbox), com ids novos a cada volta', async () => {
    const { demoCentralState } = await import('./demoCentral')
    const cwdOf = (r: number) => `C:\\demo\\p${r}`
    expect(demoCentralState(10_000, 0, 0, cwdOf).entries).toEqual([])
    const at = demoCentralState(110_000, 0, 2, cwdOf).entries
    expect(deliveredOf(feed({ conversations: [central(at as CentralRequestEntry[])] })).map((d) => [d.id, d.target.kind, d.convId])).toEqual([
      ['demo-central-2-0', 'conversation', 'demo-1-0'],
      ['demo-central-2-1', 'new-conversation', null],
      ['demo-central-2-2', 'new-sandbox', null]
    ])
  })

  it('CentralPulses: a entrega nova vira um pulso que anda e acaba no destino; o gesto de enviar; fora da tela acaba na hora', () => {
    const parent = new Group()
    const p = new CentralPulses(parent)
    const send = vi.fn()
    p.onSend = send
    const layout = layoutOffice(deriveOfficeModel(feed({ conversations: [conv('a', { updatedAt: NOW })] }), NOW))
    const lod = { culled: false, level: 0 } as never as { culled: boolean }
    p.feed(feed({ conversations: [central([])] }), layout, lod as never)
    p.feed(feed({ conversations: [central([entry('e1', 'delivered', toA)])] }), layout, lod as never)
    expect([p.running, send.mock.calls.length]).toEqual([1, 1])
    expect(p.animate(0.1)).toBe(true)
    // Anda até o fim e some.
    for (let i = 0; i < 100 && p.animate(0.1); i++);
    expect(p.running).toBe(0)
    p.feed(feed({ conversations: [central([entry('e1', 'delivered', toA), entry('e2', 'delivered', { kind: 'new-sandbox' })])] }), layout, lod as never)
    expect(p.running).toBe(1)
    lod.culled = true
    expect(p.animate(1 / PULSE_SPEED)).toBe(false)
    expect(p.running).toBe(0)
    p.dispose()
    expect(parent.children).toHaveLength(0)
  })
})
