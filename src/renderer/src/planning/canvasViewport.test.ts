import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { PlanningRoteiroDto } from '@shared/ipc'
import {
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  CARD_TITLE_PX,
  FIT_MIN_ZOOM,
  MIN_TITLE_PX,
  focusColumnId,
  initialViewport,
  layoutBounds,
  restoreViewport,
  sameViewport
} from './canvasViewport'
import { CARD_W, NO_STAGE_ID, computeLayout } from './layout'
import { makeCard } from './planningTestUtils'

type Status = PlanningRoteiroDto['etapas'][number]['status']

function roteiro(...statuses: Status[]): PlanningRoteiroDto {
  return { titulo: 'Plano', etapas: statuses.map((status, i) => ({ id: `e${i + 1}`, titulo: `Etapa ${i + 1}`, status })) }
}

/** 3 etapas + "Sem etapa" = 4 colunas (0..1208px de largura). */
function wideLayout(...statuses: Status[]) {
  const cards = statuses.map((_, i) => makeCard(`c${i + 1}`, { etapa: `e${i + 1}` }))
  return computeLayout(roteiro(...statuses), cards, {})
}

describe('canvasViewport — piso de legibilidade', () => {
  it('o piso deixa o título do card com pelo menos 12px na tela', () => {
    expect(CARD_TITLE_PX * FIT_MIN_ZOOM).toBeGreaterThanOrEqual(MIN_TITLE_PX)
    expect(FIT_MIN_ZOOM).toBeLessThanOrEqual(1)
  })

  it('CARD_TITLE_PX é o font-size real de .pl-card-title no planning.css', () => {
    // Mesmo padrão dos outros testes do renderer: vitest roda na raiz do repo.
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/planning/planning.css'), 'utf8')
    const block = /\.pl-card-title\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(/font-size:\s*(\d+(?:\.\d+)?)px/.exec(block)?.[1]).toBe(String(CARD_TITLE_PX))
  })

  it('em nenhum tamanho de canvas o enquadramento inicial desce abaixo do piso', () => {
    const layout = wideLayout('concluida', 'em_andamento', 'pendente')
    for (let width = 200; width <= 2400; width += 100) {
      for (const height of [300, 500, 720, 1000]) {
        expect(initialViewport(layout, { width, height }).zoom).toBeGreaterThanOrEqual(FIT_MIN_ZOOM)
      }
    }
  })
})

describe('canvasViewport — coluna de foco', () => {
  it('em andamento vem antes de pendente e da primeira', () => {
    expect(focusColumnId(wideLayout('concluida', 'pendente', 'em_andamento'))).toBe('e3')
  })

  it('sem etapa em andamento, a 1ª pendente', () => {
    expect(focusColumnId(wideLayout('concluida', 'pendente', 'pendente'))).toBe('e2')
  })

  it('tudo concluído: a primeira coluna', () => {
    expect(focusColumnId(wideLayout('concluida', 'concluida', 'concluida'))).toBe('e1')
  })

  it('roteiro sem etapas: a coluna "Sem etapa"', () => {
    expect(focusColumnId(computeLayout(roteiro(), [makeCard('solto')], {}))).toBe(NO_STAGE_ID)
  })
})

describe('canvasViewport — enquadramento inicial', () => {
  it('plano pequeno que cabe: enquadra tudo, sem ampliar além de 100%', () => {
    const layout = computeLayout(roteiro('pendente'), [], {})
    const b = layoutBounds(layout)
    const vp = initialViewport(layout, { width: 1200, height: 800 })
    expect(vp.zoom).toBe(1)
    // Centralizado na horizontal.
    expect(vp.x + b.minX * vp.zoom).toBeCloseTo(1200 - (vp.x + b.maxX * vp.zoom))
  })

  it('não cabe: zoom no piso e a coluna em andamento no meio da tela', () => {
    const layout = wideLayout('concluida', 'pendente', 'em_andamento')
    const vp = initialViewport(layout, { width: 600, height: 700 })
    expect(vp.zoom).toBe(FIT_MIN_ZOOM)
    const col = layout.columns.find((c) => c.id === 'e3')!
    expect(vp.x + (col.x + CARD_W / 2) * vp.zoom).toBeCloseTo(300)
  })

  it('foco na 1ª coluna não deixa vazio à esquerda do plano', () => {
    const layout = wideLayout('pendente', 'pendente', 'pendente')
    const vp = initialViewport(layout, { width: 600, height: 700 })
    expect(vp.zoom).toBe(FIT_MIN_ZOOM)
    expect(vp.x + layoutBounds(layout).minX * vp.zoom).toBeCloseTo(32)
  })

  it('foco perto do fim não deixa vazio à direita do plano', () => {
    const layout = wideLayout('concluida', 'concluida', 'em_andamento')
    const vp = initialViewport(layout, { width: 1000, height: 700 })
    expect(vp.zoom).toBe(FIT_MIN_ZOOM)
    expect(vp.x + layoutBounds(layout).maxX * vp.zoom).toBeCloseTo(1000 - 32)
  })
})

describe('canvasViewport — viewport salvo', () => {
  it('volta exatamente como foi salvo', () => {
    expect(restoreViewport({ x: 40, y: -12, zoom: 1.25 })).toEqual({ x: 40, y: -12, zoom: 1.25 })
  })

  it('zoom fora dos limites do canvas é trazido para dentro', () => {
    expect(restoreViewport({ x: 0, y: 0, zoom: 9 })?.zoom).toBe(CANVAS_MAX_ZOOM)
    expect(restoreViewport({ x: 0, y: 0, zoom: 0.01 })?.zoom).toBe(CANVAS_MIN_ZOOM)
  })

  it('ausente ou inválido não restaura nada', () => {
    expect(restoreViewport(undefined)).toBeNull()
    expect(restoreViewport({ x: Number.NaN, y: 0, zoom: 1 })).toBeNull()
    expect(restoreViewport({ x: 0, y: 0, zoom: 0 })).toBeNull()
  })

  it('sameViewport ignora arredondamento, mas não movimento de verdade', () => {
    expect(sameViewport({ x: 10, y: 20, zoom: 1 }, { x: 10.2, y: 19.9, zoom: 1.0004 })).toBe(true)
    expect(sameViewport({ x: 10, y: 20, zoom: 1 }, { x: 14, y: 20, zoom: 1 })).toBe(false)
    expect(sameViewport(null, { x: 0, y: 0, zoom: 1 })).toBe(false)
  })
})
