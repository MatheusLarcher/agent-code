import { describe, expect, it } from 'vitest'
import { TILE_SIZE } from '../../office/engine'
import { overviewZoom, viewForLevel } from './zoomLevels'

// Um prédio de 5 salas lado a lado: ~240 tiles de largura (1.920 px a zoom 1).
const WIDE = { cols: 240, rows: 40 }
const PANEL = { width: 960, height: 1280 }

describe('nível prédio', () => {
  it('cabe inteiro mesmo quando nem o zoom 1 cabe (caso real: 5 salas numa aba de 480 px)', () => {
    const z = overviewZoom(PANEL, WIDE)
    expect(z).toBeLessThan(1)
    expect(WIDE.cols * TILE_SIZE * z).toBeLessThanOrEqual(PANEL.width)
  })

  it('anda em passos de 1/8, para o cache de sprites por zoom não crescer a cada redimensionamento', () => {
    expect((overviewZoom(PANEL, WIDE) * 8) % 1).toBe(0)
    expect(overviewZoom({ width: 961, height: 1280 }, WIDE)).toBe(overviewZoom(PANEL, WIDE))
  })

  it('continua inteiro quando o prédio cabe com folga', () => {
    expect(overviewZoom({ width: 4000, height: 4000 }, { cols: 50, rows: 30 })).toBe(10)
  })

  it('os níveis de perto seguem com zoom inteiro, nítido', () => {
    const room = { id: 'r', projectKey: 'r', name: 'r', col: 0, row: 0, w: 48, h: 30, doorCol: 3, doorRow: 29 }
    const sala = viewForLevel('sala', PANEL, WIDE, { room, point: null })
    expect(Number.isInteger(sala.zoom)).toBe(true)
    expect(sala.zoom).toBeGreaterThanOrEqual(1)
  })
})
