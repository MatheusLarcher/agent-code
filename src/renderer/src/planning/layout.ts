/**
 * Layout do canvas da Tela de Planejamento — puro, sem React nem xyflow.
 *
 * O fluxo é HORIZONTAL: uma coluna por etapa do roteiro, na ordem, e uma
 * coluna final "Sem etapa" para card sem etapa (ou com etapa que saiu do
 * roteiro). Cada coluna tem um cabeçalho no topo e os cards empilhados embaixo.
 *
 * Posição salva (_canvas.json) sempre prevalece sobre a calculada. Card sem
 * posição salva entra no FIM da sua coluna — abaixo de tudo o que já ocupa a
 * faixa horizontal dela, inclusive card salvo que alguém arrastou para lá —,
 * então nunca cai em cima de outro.
 */
import type { PlanningCardDto, PlanningRoteiroDto, PlanningStageStatus } from '@shared/ipc'

/** Largura fixa do card (o CSS usa a mesma). */
export const CARD_W = 248
/** Teto da altura do card: o CSS corta título e prévia para caber nisto. */
export const CARD_H = 140
export const HEADER_H = 56
export const COL_GAP = 72
export const ROW_GAP = 16
/** Distância entre o cabeçalho da coluna e o primeiro card. */
export const HEADER_GAP = 28
export const FIRST_CARD_Y = HEADER_H + HEADER_GAP

/** Id da coluna "Sem etapa". Tem '_', que id de etapa ([a-z0-9-]) não aceita. */
export const NO_STAGE_ID = '__sem-etapa'
export const NO_STAGE_LABEL = 'Sem etapa'

export interface Point {
  x: number
  y: number
}

export interface LayoutColumn {
  /** Id da etapa do roteiro, ou NO_STAGE_ID. */
  id: string
  titulo: string
  /** null na coluna "Sem etapa". */
  status: PlanningStageStatus | null
  index: number
  x: number
  /** Cards da coluna, na ordem em que chegaram. */
  cardIds: string[]
}

export interface LayoutEdge {
  id: string
  source: string
  target: string
  /** 'link' = ligação entre cards; 'sequence' = seta entre etapas seguidas. */
  kind: 'link' | 'sequence'
}

export interface PlanLayout {
  columns: LayoutColumn[]
  positions: Record<string, Point>
  edges: LayoutEdge[]
}

/** Id do nó de cabeçalho de uma coluna. ':' não existe em id de card. */
export function headerNodeId(columnId: string): string {
  return `stage:${columnId}`
}

export function isHeaderNodeId(id: string): boolean {
  return id.startsWith('stage:')
}

export function columnX(index: number): number {
  return index * (CARD_W + COL_GAP)
}

function isPoint(value: unknown): value is Point {
  const p = value as Point | null | undefined
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y)
}

/** Faixas horizontais se cruzam (card de largura CARD_W em x0 e em x1). */
function overlapsX(x0: number, x1: number): boolean {
  return x0 < x1 + CARD_W && x1 < x0 + CARD_W
}

/** Primeiro y livre abaixo de tudo o que ocupa a faixa da coluna em `x`. */
function bottomOf(x: number, occupied: Point[]): number {
  let y = FIRST_CARD_Y
  for (const r of occupied) {
    if (overlapsX(r.x, x)) y = Math.max(y, r.y + CARD_H + ROW_GAP)
  }
  return y
}

/** Coluna do card: a etapa dele se ela está no roteiro; senão, "Sem etapa". */
export function columnIdOf(card: PlanningCardDto, stageIds: ReadonlySet<string>): string {
  return card.etapa && stageIds.has(card.etapa) ? card.etapa : NO_STAGE_ID
}

export function computeLayout(
  roteiro: PlanningRoteiroDto,
  cards: PlanningCardDto[],
  saved: Record<string, Point> | undefined
): PlanLayout {
  const columns: LayoutColumn[] = []
  const stageIds = new Set<string>()
  for (const etapa of roteiro.etapas) {
    if (stageIds.has(etapa.id)) continue // roteiro editado à mão com etapa repetida
    stageIds.add(etapa.id)
    const index = columns.length
    columns.push({ id: etapa.id, titulo: etapa.titulo, status: etapa.status, index, x: columnX(index), cardIds: [] })
  }
  const lastIndex = columns.length
  columns.push({ id: NO_STAGE_ID, titulo: NO_STAGE_LABEL, status: null, index: lastIndex, x: columnX(lastIndex), cardIds: [] })
  const byId = new Map(columns.map((c) => [c.id, c]))

  const cardIds = new Set<string>()
  for (const card of cards) {
    if (cardIds.has(card.id)) continue
    cardIds.add(card.id)
    byId.get(columnIdOf(card, stageIds))?.cardIds.push(card.id)
  }

  const positions: Record<string, Point> = {}
  const occupied: Point[] = []
  for (const id of cardIds) {
    const p = saved?.[id]
    if (isPoint(p)) {
      positions[id] = { x: p.x, y: p.y }
      occupied.push(positions[id])
    }
  }
  for (const column of columns) {
    for (const id of column.cardIds) {
      if (positions[id]) continue
      const p = { x: column.x, y: bottomOf(column.x, occupied) }
      positions[id] = p
      occupied.push(p)
    }
  }

  const edges: LayoutEdge[] = []
  const stages = columns.filter((c) => c.id !== NO_STAGE_ID)
  for (let i = 0; i + 1 < stages.length; i++) {
    const a = stages[i].id
    const b = stages[i + 1].id
    edges.push({ id: `seq:${a}>${b}`, source: headerNodeId(a), target: headerNodeId(b), kind: 'sequence' })
  }
  const seen = new Set<string>()
  for (const card of cards) {
    for (const target of card.links) {
      const id = `link:${card.id}>${target}`
      if (target === card.id || !cardIds.has(target) || seen.has(id)) continue
      seen.add(id)
      edges.push({ id, source: card.id, target, kind: 'link' })
    }
  }

  return { columns, positions, edges }
}

/** Quanto da coluna cabe na tela ao centralizar (colunas longas: o topo). */
const FOCUS_SPAN = 640

/** Ponto para centralizar o canvas numa coluna: o meio dela, ou o do topo se é longa. */
export function columnFocusPoint(layout: PlanLayout, columnId: string): Point | null {
  const column = layout.columns.find((c) => c.id === columnId)
  if (!column) return null
  let bottom = HEADER_H
  for (const id of column.cardIds) {
    const p = layout.positions[id]
    if (p && overlapsX(p.x, column.x)) bottom = Math.max(bottom, p.y + CARD_H)
  }
  return { x: column.x + CARD_W / 2, y: Math.min(bottom, FOCUS_SPAN) / 2 }
}
