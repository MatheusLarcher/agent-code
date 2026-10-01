import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CrewRole } from '../../crew'
import { TILE_SIZE } from '../engine/constants'
import { TileType, type FurnitureKind, type PlacedFurniture } from '../engine/types'
import { BUBBLE_KEYS, BUBBLE_KINDS, bubbleRows } from './bubbles'
import { FURNITURE_KEYS, furnitureRows, type FurnitureVariant, type MonitorMode } from './furniture'
import { createOfficeArt, tileColorFor } from './index'
import { PALETTE } from './palette'
import { PROP_KEYS, PROP_KINDS, PROP_ROWS } from './props'
import { lookFor, ROLE_COLORS } from './roles'

const KINDS: FurnitureKind[] = [
  'mesa', 'cadeira', 'mesa-reuniao', 'cadeira-reuniao', 'divisoria', 'quadro-kanban',
  'impressora', 'porta', 'copa', 'arquivo-memorias', 'entrada', 'planta'
]

function checkRows(rows: readonly string[], keys: Record<string, unknown>): void {
  expect(rows.length).toBeGreaterThan(0)
  const w = rows[0].length
  for (const r of rows) {
    expect(r.length).toBe(w)
    for (const ch of r) if (ch !== '.') expect(keys, `letra '${ch}'`).toHaveProperty(ch)
  }
}

const place = (kind: FurnitureKind, w: number, h: number): PlacedFurniture =>
  ({ uid: kind, kind, col: 0, row: 0, w, h, blocks: true, roomId: null })

describe('móveis', () => {
  const variants: FurnitureVariant[] = []
  for (const monitor of ['off', 'type', 'read'] as MonitorMode[]) {
    for (let step = 0; step < 5; step++) {
      variants.push({ monitor, step, moved: step % 2 === 1, blink: step % 2 === 0, paperLift: step % 3 })
    }
  }

  it.each(KINDS)('%s: só letras da paleta, largura constante e = w × TILE_SIZE', (kind) => {
    for (const [w, h] of [[1, 1], [2, 1], [4, 2], [3, 6]]) {
      for (const v of variants) {
        const rows = furnitureRows(kind, w, h, v)
        checkRows(rows, FURNITURE_KEYS)
        if (!['cadeira', 'cadeira-reuniao', 'quadro-kanban', 'impressora'].includes(kind)) {
          expect(rows[0].length).toBe(w * TILE_SIZE)
        }
        expect(rows.length).toBeGreaterThanOrEqual(kind.startsWith('cadeira') ? TILE_SIZE : h * TILE_SIZE)
      }
    }
  })

  it('monitor: desligado azul; ligado escuro com linhas que rolam com o tempo', () => {
    const art = createOfficeArt()
    const mesa = place('mesa', 4, 2)
    const off = art.furnitureSprite(mesa, { active: false, t: 0 })!
    expect(off.flat()).toContain(PALETTE.monOff)
    const on0 = art.furnitureSprite(mesa, { active: true, t: 0 })!
    const on1 = art.furnitureSprite(mesa, { active: true, t: 0.2 })!
    expect(on0.flat()).toContain(PALETTE.monOn)
    expect(on0.flat()).not.toContain(PALETTE.monOff)
    expect(on1).not.toBe(on0)
    // Mesmo estado → mesma referência (o renderer cacheia por identidade).
    expect(art.furnitureSprite(mesa, { active: true, t: 0.01 })).toBe(on0)
  })

  it('monitor em leitura não rola', () => {
    expect(furnitureRows('mesa', 4, 2, { ...variants[0], monitor: 'read', step: 0 }))
      .toEqual(furnitureRows('mesa', 4, 2, { ...variants[0], monitor: 'read', step: 3 }))
  })
})

describe('balões e objetos', () => {
  it.each(BUBBLE_KINDS)('balão %s: 9 de largura, só letras da paleta', (k) => {
    const rows = bubbleRows(k)
    checkRows(rows, BUBBLE_KEYS)
    expect(rows[0].length).toBe(9)
    expect(rows).toHaveLength(8)
  })

  it.each(PROP_KINDS)('objeto %s: só letras da paleta', (k) => checkRows(PROP_ROWS[k], PROP_KEYS))

  it('createOfficeArt devolve sprites estáveis', () => {
    const art = createOfficeArt()
    for (const k of BUBBLE_KINDS) expect(art.bubbleSprite(k)).toBe(art.bubbleSprite(k))
    for (const k of PROP_KINDS) expect(art.propSprite(k)).toBe(art.propSprite(k))
  })
})

describe('tiles', () => {
  it('piso em xadrez A/B por (col+row)%2', () => {
    expect(tileColorFor(PALETTE, TileType.FLOOR, 0, 0)).toBe(PALETTE.floorB)
    expect(tileColorFor(PALETTE, TileType.FLOOR, 1, 0)).toBe(PALETTE.floorA)
    expect(tileColorFor(PALETTE, TileType.FLOOR_ALT, 1, 0)).toBe(PALETTE.floorB)
  })

  it('parede com blocos claros', () => {
    const colors = new Set<string>()
    for (let c = 0; c < 12; c++) colors.add(tileColorFor(PALETTE, TileType.WALL, c, 0))
    expect(colors).toEqual(new Set([PALETTE.wall, PALETTE.wallHi]))
  })

  it('trocar a paleta recolore', () => {
    const art = createOfficeArt({ ...PALETTE, floorA: '#000001', monOff: '#000002' })
    expect(art.tileColor(TileType.FLOOR, 1, 0)).toBe('#000001')
    expect(art.furnitureSprite(place('mesa', 4, 2), { active: false, t: 0 })!.flat()).toContain('#000002')
  })
})

describe('papéis', () => {
  it('cores batem com --crew-* de styles.css', () => {
    const css = readFileSync(resolve(__dirname, '../../styles.css'), 'utf8')
    for (const [role, color] of Object.entries(ROLE_COLORS)) {
      const m = css.match(new RegExp(`--crew-${role}:\\s*(#[0-9a-fA-F]{3,8})`))
      expect(m, `--crew-${role}`).not.toBeNull()
      expect(color.toLowerCase()).toBe(m![1].toLowerCase())
    }
  })

  it('lookFor é determinístico pela seed e veste a cor do papel', () => {
    const roles = Object.keys(ROLE_COLORS) as CrewRole[]
    for (const role of roles) {
      const a = lookFor(role, 'conversa-123')
      expect(lookFor(role, 'conversa-123')).toEqual(a)
      expect(a.outfit).toBe(ROLE_COLORS[role])
    }
    const looks = new Set(Array.from({ length: 30 }, (_, i) => JSON.stringify(lookFor('executor', `s${i}`))))
    expect(looks.size).toBeGreaterThan(1)
  })
})
