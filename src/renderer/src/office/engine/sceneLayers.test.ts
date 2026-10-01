import { describe, expect, it, vi } from 'vitest'
import { buildBubbleItems, buildSceneItems, backgroundFurnitureItems } from './sceneLayers'
import { LOOK, newOffice, runUntil } from './testFixtures'
import { CharacterState } from './types'
import type { OfficeArt, SpriteData } from './types'

function solid(w: number, h: number, color: string): SpriteData {
  return Array.from({ length: h }, () => new Array<string>(w).fill(color))
}

/** Arte de teste: sprites estáveis por chave, como a de verdade deve ser. */
function fakeArt() {
  const furniture = new Map<string, SpriteData>()
  const character = solid(6, 10, '#c00')
  const bubble = solid(9, 8, '#fff')
  const prop = solid(3, 3, '#0c0')
  const art: OfficeArt = {
    tileColor: () => '#888',
    furnitureSprite: vi.fn((f, ctx) => {
      const k = `${f.uid}:${ctx.active}`
      if (!furniture.has(k)) furniture.set(k, solid(f.w * 8, f.h * 8 + 4, ctx.active ? '#0f0' : '#333'))
      return furniture.get(k)!
    }),
    characterSprite: () => character,
    bubbleSprite: () => bubble,
    propSprite: () => prop
  }
  return { art, character, bubble, prop }
}

describe('cena', () => {
  it('monitor liga (active) quando o dono do assento está ativo — por deskUid e por deskOfSeat', () => {
    const office = newOffice()
    const { art } = fakeArt()
    office.addAgent(1, { roomId: 'A', look: LOOK })
    office.addAgent(2, { roomId: 'A', look: LOOK, slot: 'executor' })
    buildSceneItems(office, art)
    const calls = vi.mocked(art.furnitureSprite).mock.calls
    const activeOf = (uid: string) => calls.filter(([f]) => f.uid === uid).at(-1)![1].active
    expect(activeOf('deskA1')).toBe(true)
    expect(activeOf('deskA2')).toBe(true)
    expect(activeOf('deskB1')).toBe(false)

    office.setAgentActive(1, false)
    buildSceneItems(office, art)
    expect(activeOf('deskA1')).toBe(false)
    expect(activeOf('deskA2')).toBe(true)
  })

  it('z-sort por Y: sentado abaixo da mesa fica na frente; atrás da mesa fica atrás', () => {
    const office = newOffice()
    const { art, character } = fakeArt()
    office.addAgent(1, { roomId: 'A', look: LOOK })
    const ch = office.getCharacter(1)!
    runUntil(office, () => ch.state === CharacterState.TYPE)
    // deskA1: footprint (3–4, 2) → base em y = 3 tiles; chairA1 em (3,3) → base 4 tiles.
    const positions = () => {
      const items = buildSceneItems(office, art)
      return {
        person: items.findIndex((i) => i.sprite === character),
        desk: items.findIndex((i) => i.x === 3 * 8 && i.zY === 3 * 8),
        chair: items.findIndex((i) => i.x === 3 * 8 && i.zY === 4 * 8)
      }
    }
    const seated = positions()
    expect(seated.person).toBeGreaterThan(seated.desk)
    expect(seated.person).toBeGreaterThan(seated.chair)

    // De pé em (4,1), atrás da mesa: desenhado antes dela.
    office.setAgentActive(1, false)
    expect(office.walkToTile(1, 4, 1)).toBe(true)
    runUntil(office, () => ch.tileCol === 4 && ch.tileRow === 1 && ch.state !== CharacterState.WALK)
    const behind = positions()
    expect(behind.person).toBeLessThan(behind.desk)
  })

  it('móvel rente ao chão vai para o fundo estático, não para o z-sort', () => {
    const office = newOffice()
    const { art } = fakeArt()
    expect(backgroundFurnitureItems(office.layout, art)).toHaveLength(1)
    const sceneUids = vi.mocked(art.furnitureSprite).mock.calls.map(([f]) => f.uid)
    expect(sceneUids).toEqual(['matA'])
    vi.mocked(art.furnitureSprite).mockClear()
    buildSceneItems(office, art)
    expect(vi.mocked(art.furnitureSprite).mock.calls.map(([f]) => f.uid)).not.toContain('matA')
  })

  it('balão por cima, com fade no fim; objeto acompanha o personagem', () => {
    const office = newOffice()
    const { art, bubble, prop } = fakeArt()
    office.addAgent(1, { roomId: 'A', look: LOOK })
    office.showBubble(1, 'ok', 1)
    office.setProp(1, 'celular')
    expect(buildBubbleItems(office, art)[0]).toMatchObject({ sprite: bubble, alpha: 1 })
    office.update(0.75)
    expect(buildBubbleItems(office, art)[0].alpha).toBeCloseTo(0.5, 5)
    expect(buildSceneItems(office, art).some((i) => i.sprite === prop)).toBe(true)
  })
})
