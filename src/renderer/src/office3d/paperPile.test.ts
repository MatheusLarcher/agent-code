import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstancedMesh, Mesh, Sprite } from 'three'
import { deriveOfficeModel } from '../office/adapter/model'
import type { Character3D } from './characters'
import type { RoomView } from './decor'
import { demoFeed } from './demoFeed'
import { DEMO_LOOP_MS } from './demoTimeline'
import { layoutOffice } from './layout'
import { MAX_REAMS, PAPER_STEPS, paperStep } from './paperPile'
import { OfficeScene } from './scene'

const T0 = 14_916_667 * DEMO_LOOP_MS

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('pilha de papéis na mesa (contexto de cada agente)', () => {
  it('cresce em degraus: 50/80/90/95% do contexto usado', () => {
    expect(PAPER_STEPS).toEqual([0.5, 0.8, 0.9, 0.95])
    const at = (used: number): number => paperStep({ tokens: used * 200_000, max: 200_000 })
    expect([0, 0.49, 0.5, 0.79, 0.8, 0.9, 0.94, 0.95, 1].map(at)).toEqual([0, 0, 1, 1, 2, 3, 3, 4, 4])
    expect(paperStep(undefined)).toBe(0)
    expect(paperStep({ tokens: 10, max: 0 })).toBe(0)
  })

  it('a cena põe a pilha do dono em cada mesa (uma InstancedMesh por ilha, some no LONGE) e a bateria saiu de cima da cabeça', () => {
    const now = T0 + 60_000
    const feed = demoFeed(now)
    const layout = layoutOffice(deriveOfficeModel(feed, now))
    const s = new OfficeScene()
    s.sync(layout, feed)
    const rooms = (s as unknown as { rooms: Map<string, RoomView> }).rooms
    let total = 0
    let tall = 0
    for (const r of layout.rooms) {
      const v = rooms.get(r.id)!
      let sum = 0
      r.desks.forEach((d, i) => {
        const owner = layout.characters.find((c) => c.key === d.ownerKey)?.model
        expect(v.piles.step(i)).toBe(paperStep(owner?.context))
        sum += v.piles.step(i)
        if (v.piles.step(i) >= 3) tall++
      })
      // Uma pilha (InstancedMesh) por ilha, marcada 'small' e no LOD da zona dela.
      const piles = v.zones.flatMap((z) => z.group.children.filter((o): o is InstancedMesh => o instanceof InstancedMesh && o.name === 'paper-piles').map((m) => ({ m, z })))
      expect(piles).toHaveLength(4)
      expect(piles.reduce((n, p) => n + p.m.count, 0)).toBe(sum)
      for (const { m, z } of piles) {
        expect(m.userData.lod).toBe('small')
        expect(z.lod.small).toContain(m)
      }
      total += sum
    }
    // A demo tem contexto em todas as faixas: há mesas com pilha alta.
    expect(total).toBeGreaterThan(0)
    expect(tall).toBeGreaterThan(0)
    expect(MAX_REAMS).toBe(4)
    // Acima da cabeça só ficam os "z" do cochilo (e o indicador quando houver): nenhuma bateria.
    expect('battery' in s['kit'].mat).toBe(false)
    const chars = (s as unknown as { charList: Character3D[] }).charList
    expect(chars.length).toBeGreaterThan(0)
    for (const c of chars) {
      const hud = c.group.children.find((o) => o.children.some((x) => x instanceof Sprite))!
      // A bateria era um grupo (casca, polo e carga) no HUD; agora só sprites e, às vezes, o indicador.
      expect(hud.children.every((o) => o instanceof Sprite || o instanceof Mesh)).toBe(true)
    }
    s.dispose()
  })
})
