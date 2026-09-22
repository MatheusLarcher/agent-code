/**
 * Enquadramento inicial do canvas — puro, sem React nem xyflow.
 *
 * Regra, em ordem:
 * 1. Viewport salvo em _canvas.json → volta exatamente como o usuário deixou.
 * 2. O plano inteiro cabe com o título do card legível → enquadra tudo.
 * 3. Não cabe → zoom no piso legível, focado na coluna da etapa em andamento
 *    (ou a 1ª pendente, ou a 1ª); o resto se alcança arrastando.
 *
 * "Legível" = o título do card (13px no planning.css) com pelo menos 12px
 * efetivos na tela. Por isso o piso é 12/13, e não um número mágico.
 */
import { CARD_H, CARD_W, HEADER_H, type PlanLayout } from './layout'

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export interface CanvasSize {
  width: number
  height: number
}

/** font-size de .pl-card-title no planning.css (o teste confere). */
export const CARD_TITLE_PX = 13
/** Menor tamanho efetivo aceitável para o título do card. */
export const MIN_TITLE_PX = 12
/** Piso de zoom do enquadramento automático: título >= MIN_TITLE_PX na tela. */
export const FIT_MIN_ZOOM = MIN_TITLE_PX / CARD_TITLE_PX
/** Enquadrar tudo nunca amplia além do tamanho real. */
export const FIT_MAX_ZOOM = 1
/** Limites do zoom manual (os mesmos do <ReactFlow>). */
export const CANVAS_MIN_ZOOM = 0.2
export const CANVAS_MAX_ZOOM = 1.75

/** Folga nas bordas; em cima, espaço para a barra '+ Card'. */
const PAD_X = 32
const PAD_TOP = 64
const PAD_BOTTOM = 32

interface Rect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi)
}

/**
 * Coluna em que o enquadramento foca: a 1ª etapa em andamento, senão a 1ª
 * pendente, senão a 1ª coluna (que, sem etapas, é a "Sem etapa").
 */
export function focusColumnId(layout: PlanLayout): string | null {
  const cols = layout.columns
  return (
    cols.find((c) => c.status === 'em_andamento')?.id ??
    cols.find((c) => c.status === 'pendente')?.id ??
    cols[0]?.id ??
    null
  )
}

/** Retângulo que contém cabeçalhos e cards (card pelo teto CARD_H). */
export function layoutBounds(layout: PlanLayout): Rect {
  const r: Rect = { minX: Infinity, minY: 0, maxX: -Infinity, maxY: HEADER_H }
  for (const col of layout.columns) {
    r.minX = Math.min(r.minX, col.x)
    r.maxX = Math.max(r.maxX, col.x + CARD_W)
  }
  for (const p of Object.values(layout.positions)) {
    r.minX = Math.min(r.minX, p.x)
    r.maxX = Math.max(r.maxX, p.x + CARD_W)
    r.minY = Math.min(r.minY, p.y)
    r.maxY = Math.max(r.maxY, p.y + CARD_H)
  }
  if (!Number.isFinite(r.minX)) return { minX: 0, minY: 0, maxX: CARD_W, maxY: HEADER_H }
  return r
}

/** Enquadramento para quando não há viewport salvo (canvas já medido). */
export function initialViewport(layout: PlanLayout, size: CanvasSize): Viewport {
  const b = layoutBounds(layout)
  const bw = b.maxX - b.minX
  const bh = b.maxY - b.minY
  const availW = Math.max(1, size.width - 2 * PAD_X)
  const availH = Math.max(1, size.height - PAD_TOP - PAD_BOTTOM)
  const fit = Math.min(FIT_MAX_ZOOM, availW / bw, availH / bh)

  if (fit >= FIT_MIN_ZOOM) {
    return {
      x: (size.width - bw * fit) / 2 - b.minX * fit,
      y: PAD_TOP + (availH - bh * fit) / 2 - b.minY * fit,
      zoom: fit
    }
  }

  const zoom = FIT_MIN_ZOOM
  const col = layout.columns.find((c) => c.id === focusColumnId(layout))
  const centerX = col ? col.x + CARD_W / 2 : (b.minX + b.maxX) / 2
  // Coluna no meio da tela, mas sem deixar vazio à esquerda da 1ª coluna nem
  // à direita da última quando dá para mostrar mais plano. Se a largura cabe
  // (só a altura não), o plano fica centralizado na horizontal.
  const wanted = size.width / 2 - centerX * zoom
  const leftmost = size.width - PAD_X - b.maxX * zoom // conteúdo encostado à direita
  const rightmost = PAD_X - b.minX * zoom // conteúdo encostado à esquerda
  const x = leftmost < rightmost ? clamp(wanted, leftmost, rightmost) : (size.width - bw * zoom) / 2 - b.minX * zoom
  return { x, y: PAD_TOP - b.minY * zoom, zoom }
}

/** Viewport salvo utilizável (zoom dentro dos limites do canvas), ou null. */
export function restoreViewport(saved: Partial<Viewport> | null | undefined): Viewport | null {
  if (!saved || !finite(saved.x) || !finite(saved.y) || !finite(saved.zoom) || saved.zoom <= 0) return null
  return { x: saved.x, y: saved.y, zoom: clamp(saved.zoom, CANVAS_MIN_ZOOM, CANVAS_MAX_ZOOM) }
}

/** Mesmo enquadramento, a menos de arredondamento (meio pixel, milésimo de zoom). */
export function sameViewport(a: Viewport | null, b: Viewport | null): boolean {
  if (!a || !b) return false
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.zoom - b.zoom) < 1e-3
}
