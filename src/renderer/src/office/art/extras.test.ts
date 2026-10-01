import { describe, expect, it } from 'vitest'
import { createOfficeArt, PALETTE } from '.'
import { deskRows, kanbanRows, PILE_HEIGHTS, printerRows, variantFor } from './furniture'
import { WAVE_FRAMES, waveRows } from './waves'
import type { PlacedFurniture } from '../engine/types'

const count = (rows: string[], k: string): number => rows.join('').split(k).length - 1

describe('adereços da F4·4-5', () => {
  it('xícara (café) e crachá (com brilho) existem na arte', () => {
    const art = createOfficeArt()
    expect(art.propSprite('xicara').flat()).toContain(PALETTE.coffee)
    expect(art.propSprite('cracha').flat()).toContain(PALETTE.postYellow)
    expect(art.propSprite('cracha').flat()).toContain(PALETTE.postBlue)
  })

  it('ondas: três quadros no formato do balão, referência estável por quadro', () => {
    const art = createOfficeArt()
    expect(WAVE_FRAMES).toBe(3)
    const f0 = art.wavesSprite!(0)
    expect(art.wavesSprite!(3)).toBe(f0)
    expect(art.wavesSprite!(1)).not.toBe(f0)
    expect(waveRows(2)).toHaveLength(8)
    expect(f0.flat()).toContain(PALETTE.amber)
  })

  it('pilha de papéis cresce em 3 degraus na mesa', () => {
    const sizes = [0, 1, 2, 3].map((p) => count(deskRows(2, 1, 'off', 0, p), 'p') + count(deskRows(2, 1, 'off', 0, p), 'q'))
    expect(sizes).toEqual(PILE_HEIGHTS.map((h) => h * 3))
    // Sem pilha, a mesa é a mesma de antes.
    expect(deskRows(2, 1, 'off', 0, 0)).toEqual(deskRows(2, 1, 'off', 0))
  })

  it('impressora: apagada sem contador; com contador mostra o algarismo; > 9 vira "+"', () => {
    const off = printerRows(2, 1, false, 0)
    expect(count(off, 'L')).toBe(0)
    const on = printerRows(2, 1, true, 1, 3)
    expect(count(on, 'L')).toBeGreaterThan(2)
    expect(printerRows(2, 1, true, 1, 12)).not.toEqual(printerRows(2, 1, true, 1, 3))
    // Mesma largura/altura em todos os estados (o motor ancora pela base).
    expect(on.length).toBe(off.length)
  })

  it('kanban não troca o post-it sozinho com o tempo (só quando o PO cola)', () => {
    const k: PlacedFurniture = { uid: 'k', kind: 'quadro-kanban', col: 0, row: 0, w: 3, h: 1, blocks: true, roomId: 'r' }
    expect(variantFor(k, { active: false, t: 4.5 }).moved).toBe(false)
    expect(kanbanRows(3, 1, true)).not.toEqual(kanbanRows(3, 1, false))
  })
})
