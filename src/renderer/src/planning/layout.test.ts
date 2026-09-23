import { describe, it, expect } from 'vitest'
import type { PlanningCardDto, PlanningRoteiroDto } from '@shared/ipc'
import {
  CARD_H,
  CARD_W,
  FIRST_CARD_Y,
  NO_STAGE_ID,
  NO_STAGE_LABEL,
  columnFocusPoint,
  computeLayout,
  headerNodeId,
  type Point
} from './layout'

function card(id: string, over: Partial<PlanningCardDto> = {}): PlanningCardDto {
  return { id, tipo: 'requisito', titulo: id, links: [], rev: 1, corpo: '', ...over }
}

const roteiro: PlanningRoteiroDto = {
  titulo: 'Plano',
  etapas: [
    { id: 'requisitos', titulo: 'Levantar requisitos', status: 'concluida' },
    { id: 'desenho', titulo: 'Desenhar a solução', status: 'em_andamento' },
    { id: 'entrega', titulo: 'Entregar', status: 'pendente' }
  ]
}

/** Dois cards se sobrepõem se os retângulos CARD_W × CARD_H se cruzam. */
function overlap(a: Point, b: Point): boolean {
  return a.x < b.x + CARD_W && b.x < a.x + CARD_W && a.y < b.y + CARD_H && b.y < a.y + CARD_H
}

function assertNoOverlap(positions: Record<string, Point>): void {
  const list = Object.entries(positions)
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      expect(overlap(list[i][1], list[j][1]), `${list[i][0]} × ${list[j][0]}`).toBe(false)
    }
  }
}

describe('computeLayout — colunas por etapa', () => {
  it('uma coluna por etapa, na ordem do roteiro, e "Sem etapa" por último', () => {
    const { columns } = computeLayout(roteiro, [], undefined)
    expect(columns.map((c) => c.id)).toEqual(['requisitos', 'desenho', 'entrega', NO_STAGE_ID])
    expect(columns.at(-1)?.titulo).toBe(NO_STAGE_LABEL)
    expect(columns.at(-1)?.status).toBeNull()
    // Fluxo horizontal: x cresce da esquerda para a direita, sem colunas coladas.
    for (let i = 1; i < columns.length; i++) {
      expect(columns[i].x).toBeGreaterThanOrEqual(columns[i - 1].x + CARD_W)
    }
  })

  it('empilha os cards na coluna da sua etapa, sem sobrepor', () => {
    const cards = [card('a', { etapa: 'desenho' }), card('b', { etapa: 'desenho' }), card('c', { etapa: 'requisitos' })]
    const { columns, positions } = computeLayout(roteiro, cards, undefined)
    const desenho = columns.find((c) => c.id === 'desenho')!
    expect(desenho.cardIds).toEqual(['a', 'b'])
    expect(positions.a).toEqual({ x: desenho.x, y: FIRST_CARD_Y })
    expect(positions.b.x).toBe(desenho.x)
    expect(positions.b.y).toBeGreaterThanOrEqual(positions.a.y + CARD_H)
    expect(positions.c.x).toBe(columns[0].x)
    assertNoOverlap(positions)
  })

  it('card sem etapa, ou com etapa fora do roteiro, vai para "Sem etapa"', () => {
    const cards = [card('solto'), card('orfao', { etapa: 'etapa-que-saiu' }), card('ok', { etapa: 'entrega' })]
    const { columns, positions } = computeLayout(roteiro, cards, undefined)
    const semEtapa = columns.at(-1)!
    expect(semEtapa.cardIds).toEqual(['solto', 'orfao'])
    expect(positions.solto.x).toBe(semEtapa.x)
    expect(positions.orfao.x).toBe(semEtapa.x)
  })

  it('roteiro vazio ainda tem a coluna "Sem etapa"', () => {
    const { columns, positions } = computeLayout({ titulo: '', etapas: [] }, [card('x')], undefined)
    expect(columns.map((c) => c.id)).toEqual([NO_STAGE_ID])
    expect(positions.x).toEqual({ x: 0, y: FIRST_CARD_Y })
  })
})

describe('computeLayout — posição salva', () => {
  it('a posição salva prevalece sobre a calculada', () => {
    const cards = [card('a', { etapa: 'requisitos' })]
    const { positions } = computeLayout(roteiro, cards, { a: { x: 999, y: -40 } })
    expect(positions.a).toEqual({ x: 999, y: -40 })
  })

  it('card novo sem posição entra no fim da coluna, abaixo de um card salvo lá', () => {
    const cards = [card('antigo', { etapa: 'desenho' }), card('novo', { etapa: 'desenho' })]
    const base = computeLayout(roteiro, [], undefined)
    const x = base.columns[1].x
    const { positions } = computeLayout(roteiro, cards, { antigo: { x, y: 600 } })
    expect(positions.antigo).toEqual({ x, y: 600 })
    expect(positions.novo.x).toBe(x)
    expect(positions.novo.y).toBeGreaterThanOrEqual(600 + CARD_H)
    assertNoOverlap(positions)
  })

  it('não sobrepõe card de outra coluna que foi arrastado para a faixa desta', () => {
    const base = computeLayout(roteiro, [], undefined)
    const x = base.columns[2].x
    const cards = [card('arrastado', { etapa: 'requisitos' }), card('novo', { etapa: 'entrega' })]
    const { positions } = computeLayout(roteiro, cards, { arrastado: { x: x + 30, y: FIRST_CARD_Y + 10 } })
    expect(positions.novo.x).toBe(x)
    assertNoOverlap(positions)
  })

  it('ignora posição salva inválida e posição de card que não existe', () => {
    const cards = [card('a', { etapa: 'entrega' })]
    const saved = { a: { x: Number.NaN, y: 3 }, fantasma: { x: 1, y: 1 } }
    const { positions } = computeLayout(roteiro, cards, saved)
    expect(Object.keys(positions)).toEqual(['a'])
    expect(positions.a.y).toBe(FIRST_CARD_Y)
  })

  it('muitos cards novos misturados a salvos nunca se sobrepõem', () => {
    const cards = Array.from({ length: 12 }, (_, i) => card(`c${i}`, { etapa: i % 2 ? 'desenho' : undefined }))
    const x = computeLayout(roteiro, [], undefined).columns[1].x
    const saved = { c1: { x, y: FIRST_CARD_Y + 5 }, c3: { x: x + 10, y: 420 } }
    assertNoOverlap(computeLayout(roteiro, cards, saved).positions)
  })
})

describe('computeLayout — arestas', () => {
  it('setas de sequência ligam cabeçalhos de etapas consecutivas', () => {
    const { edges } = computeLayout(roteiro, [], undefined)
    const seq = edges.filter((e) => e.kind === 'sequence')
    expect(seq.map((e) => [e.source, e.target])).toEqual([
      [headerNodeId('requisitos'), headerNodeId('desenho')],
      [headerNodeId('desenho'), headerNodeId('entrega')]
    ])
  })

  it('links viram arestas só quando o alvo existe (sem auto-link nem repetição)', () => {
    const cards = [card('a', { links: ['b', 'b', 'a', 'sumiu'] }), card('b', { links: ['a'] })]
    const links = computeLayout(roteiro, cards, undefined).edges.filter((e) => e.kind === 'link')
    expect(links.map((e) => `${e.source}>${e.target}`)).toEqual(['a>b', 'b>a'])
  })

  it('[[Título]] no corpo vira seta, resolvida pelo título sem acento/caixa e, por compatibilidade, pelo id', () => {
    const cards = [
      card('login', { titulo: 'Login com SSO', corpo: 'Depende de [[usar postgres]] e de [[relatorio]].' }),
      card('banco', { titulo: 'Usar Postgres' }),
      card('relatorio', { titulo: 'Relatório mensal', corpo: 'Ver [[Ação de cobrança]]' }),
      card('acao', { titulo: 'Acao de Cobranca' })
    ]
    const refs = computeLayout(roteiro, cards, undefined).edges.filter((e) => e.kind === 'ref')
    expect(refs.map((e) => `${e.id}`)).toEqual(['ref:login>banco', 'ref:login>relatorio', 'ref:relatorio>acao'])
  })

  it('referência que já é link explícito não duplica a seta; a que não resolve (ou aponta para si) não gera seta', () => {
    const cards = [
      card('a', { titulo: 'Card A', links: ['b'], corpo: '[[Card B]] [[card b]] [[Fantasma]] [[Card A]] [[b]]' }),
      card('b', { titulo: 'Card B', corpo: '[[Card A]]' })
    ]
    const edges = computeLayout(roteiro, cards, undefined).edges.filter((e) => e.kind !== 'sequence')
    expect(edges.map((e) => e.id)).toEqual(['link:a>b', 'ref:b>a'])
  })
})

describe('columnFocusPoint', () => {
  it('aponta para o meio horizontal da coluna', () => {
    const layout = computeLayout(roteiro, [card('a', { etapa: 'desenho' })], undefined)
    const p = columnFocusPoint(layout, 'desenho')!
    expect(p.x).toBe(layout.columns[1].x + CARD_W / 2)
    expect(p.y).toBeGreaterThan(0)
    expect(columnFocusPoint(layout, 'nao-existe')).toBeNull()
  })
})
