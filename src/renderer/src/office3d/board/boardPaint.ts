/**
 * A textura do kanban de UMA sala: um canvas 2D só, redesenhado SÓ quando o
 * quadro muda (e com a sala à vista e perto). Em cima, a face (cabeçalhos das
 * colunas com contador, bilhete de vazio ou plaquinha de indisponível); embaixo,
 * as células dos papéis — cada papel na parede aponta (UV) para a célula dele.
 *
 *   células 0..2   pilhas "+K" (uma por coluna)
 *   células 3..20  papéis (título efetivo em até 3 linhas com "…", alfinete na
 *                  cor do agente, marca do PO, clipe de aguardando/interrompido,
 *                  carimbo ✓ de concluído)
 *
 * Sem contexto 2D (jsdom) nada é desenhado — nada quebra.
 */
import type { BoardItemStatus, BoardTurnEndKind } from '@shared/ipc'
import { BOARD_COLUMNS } from './boardModel'
import { FACE_H, FACE_W, HEADER_H, PAPER_H, PAPER_W } from './boardLayout'

export const ATLAS = 1024
/** Face: largura do canvas, altura na proporção da face. */
export const FACE_PX_W = ATLAS
export const FACE_PX_H = Math.round((ATLAS * FACE_H) / FACE_W)
/** Células: 3 por linha, com calha (a mipmap não mistura vizinhas). */
const CELL_TOP = FACE_PX_H + 6
const GUTTER = 4
export const CELL_W = 332
export const CELL_H = Math.round((CELL_W * PAPER_H) / PAPER_W)
const SLOT_W = CELL_W + GUTTER * 2
const SLOT_H = CELL_H + GUTTER * 2
const CELL_LEFT = Math.floor((ATLAS - SLOT_W * 3) / 2)
export const PILE_CELLS = 3
export const CARD_CELLS = 18
export const CELLS = PILE_CELLS + CARD_CELLS

/** Retângulo (px) do conteúdo da célula `i`. */
export function cellRect(i: number): { x: number; y: number; w: number; h: number } {
  const col = i % 3
  const row = Math.floor(i / 3)
  return { x: CELL_LEFT + col * SLOT_W + GUTTER, y: CELL_TOP + row * SLOT_H + GUTTER, w: CELL_W, h: CELL_H }
}

/** Cor do papel por coluna (a mesma no MÉDIO, sem textura). */
export const PAPER_COLORS: Record<BoardItemStatus, string> = {
  pending: '#fff8d6',
  in_progress: '#ffe7cc',
  completed: '#e8f5de'
}
export const FACE_COLOR = '#e6d3ad'
export const PILE_COLOR = '#f6eedb'
const INK = '#2d2721'
const PO_COLOR = '#d97757'
const CLIP_COLORS: Record<BoardTurnEndKind, string> = { result: '#e0a458', error: '#d97070' }

export type FaceState = 'loading' | 'unavailable' | 'empty' | 'ok'

export interface FaceInfo {
  state: FaceState
  counts: readonly number[]
}

export interface PaperInfo {
  title: string
  status: BoardItemStatus
  awaiting: BoardTurnEndKind | null
  po: boolean
  /** Cor (CSS) da camisa do agente da conversa dona. */
  pin: string
}

const FONT = '"Segoe UI", system-ui, sans-serif'

function round(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Quebra em até `max` linhas que cabem em `width`; a última leva "…" se sobrar texto. */
export function wrapLines(ctx: Pick<CanvasRenderingContext2D, 'measureText'>, text: string, width: number, max: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const lines: string[] = []
  let cur = ''
  const fits = (s: string): boolean => ctx.measureText(s).width <= width
  let i = 0
  while (i < words.length) {
    const w = words[i]
    const next = cur ? `${cur} ${w}` : w
    if (fits(next)) {
      cur = next
      i++
      continue
    }
    if (!cur) {
      // Palavra maior que a linha: corta por letra (o resto segue na próxima).
      let k = w.length - 1
      while (k > 1 && !fits(w.slice(0, k))) k--
      cur = w.slice(0, k)
      words[i] = w.slice(k)
    }
    lines.push(cur)
    cur = ''
    if (lines.length === max) break
  }
  // Só sai antes do fim com `max` linhas cheias (e palavra sobrando).
  const truncated = i < words.length
  if (!truncated && cur) lines.push(cur)
  if (truncated && lines.length > 0) {
    let last = lines[lines.length - 1]
    while (last.length > 0 && !fits(`${last}…`)) last = last.slice(0, -1).trimEnd()
    lines[lines.length - 1] = `${last}…`
  }
  return lines
}

/** A face: fundo, divisórias, cabeçalhos com contador e o estado (vazio, indisponível). */
export function paintFace(ctx: CanvasRenderingContext2D, face: FaceInfo): void {
  const W = FACE_PX_W
  const H = FACE_PX_H
  ctx.fillStyle = FACE_COLOR
  ctx.fillRect(0, 0, W, H)
  const colW = W / BOARD_COLUMNS.length
  const headH = Math.round((H * HEADER_H) / FACE_H)
  BOARD_COLUMNS.forEach((col, i) => {
    const x = i * colW
    ctx.fillStyle = col.color
    ctx.globalAlpha = 0.28
    ctx.fillRect(x + 6, 6, colW - 12, headH - 6)
    ctx.globalAlpha = 1
    ctx.fillStyle = col.color
    ctx.fillRect(x + 6, headH - 4, colW - 12, 4)
    if (i > 0) {
      ctx.fillStyle = 'rgba(80,60,40,0.18)'
      ctx.fillRect(x - 1, 10, 2, H - 20)
    }
    ctx.fillStyle = INK
    ctx.font = `700 26px ${FONT}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(col.label, x + 20, headH / 2 + 2)
    const n = face.state === 'ok' || face.state === 'empty' ? String(face.counts[i] ?? 0) : '–'
    ctx.font = `700 22px ${FONT}`
    const nw = Math.max(34, ctx.measureText(n).width + 18)
    ctx.fillStyle = col.color
    round(ctx, x + colW - 20 - nw, headH / 2 - 14, nw, 28, 14)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.fillText(n, x + colW - 20 - nw / 2, headH / 2 + 1)
  })
  if (face.state === 'empty') sticky(ctx, W / 2, H / 2 + headH / 2, 'Nenhuma tarefa ainda')
  else if (face.state === 'unavailable') plaque(ctx, W / 2, H / 2 + headH / 2)
}

function sticky(ctx: CanvasRenderingContext2D, cx: number, cy: number, text: string): void {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(-0.04)
  ctx.fillStyle = 'rgba(0,0,0,0.12)'
  ctx.fillRect(-150 + 5, -46 + 6, 300, 92)
  ctx.fillStyle = '#fff3a6'
  ctx.fillRect(-150, -46, 300, 92)
  ctx.fillStyle = '#c94c4c'
  ctx.beginPath()
  ctx.arc(0, -34, 8, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = INK
  ctx.font = `600 26px ${FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 0, 8)
  ctx.restore()
}

function plaque(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.fillStyle = 'rgba(0,0,0,0.18)'
  round(ctx, -205 + 4, -52 + 6, 410, 104, 12)
  ctx.fill()
  ctx.fillStyle = '#5c616b'
  round(ctx, -205, -52, 410, 104, 12)
  ctx.fill()
  ctx.fillStyle = '#c9ccd2'
  for (const [sx, sy] of [[-188, -36], [188, -36], [-188, 36], [188, 36]]) {
    ctx.beginPath()
    ctx.arc(sx, sy, 5, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `700 30px ${FONT}`
  ctx.fillText('Quadro indisponível', 0, -10)
  ctx.font = `500 18px ${FONT}`
  ctx.fillStyle = '#dfe2e7'
  ctx.fillText('o banco do app está fora agora', 0, 24)
  ctx.restore()
}

/** Um papel: cor da coluna, alfinete do agente, título, marca do PO, clipe e carimbo. */
export function paintPaper(ctx: CanvasRenderingContext2D, cell: number, p: PaperInfo): void {
  const { x, y, w, h } = cellRect(cell)
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  ctx.fillStyle = PAPER_COLORS[p.status]
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = 'rgba(90,60,30,0.10)'
  ctx.fillRect(x, y + h - 4, w, 4)
  const done = p.status === 'completed'
  const right = done ? 46 : 14
  ctx.fillStyle = INK
  ctx.globalAlpha = done ? 0.72 : 1
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  const left = p.awaiting ? 24 : 14
  // Título grande em até 2 linhas; se não couber, menor em até 3 (com "…").
  ctx.font = `600 21px ${FONT}`
  let lines = wrapLines(ctx, p.title, w - left - right, 2)
  let lh = 23
  let top = y + 38
  if (lines.length === 2 && lines[1].endsWith('…')) {
    ctx.font = `600 17px ${FONT}`
    lines = wrapLines(ctx, p.title, w - left - right, 3)
    lh = 18
    top = y + 32
  }
  lines.forEach((line, i) => ctx.fillText(line, x + left, top + i * lh))
  ctx.globalAlpha = 1
  // Alfinete na cor da camisa do agente da conversa dona.
  ctx.fillStyle = 'rgba(0,0,0,0.25)'
  ctx.beginPath()
  ctx.arc(x + w / 2 + 2, y + 11, 7, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = p.pin
  ctx.beginPath()
  ctx.arc(x + w / 2, y + 9, 7, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.beginPath()
  ctx.arc(x + w / 2 - 2, y + 7, 2.2, 0, Math.PI * 2)
  ctx.fill()
  // Criado pelo PO: dobra no canto, na cor do PO.
  if (p.po) {
    ctx.fillStyle = PO_COLOR
    ctx.beginPath()
    ctx.moveTo(x + w - 26, y)
    ctx.lineTo(x + w, y)
    ctx.lineTo(x + w, y + 26)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.font = `700 9px ${FONT}`
    ctx.textAlign = 'center'
    ctx.fillText('PO', x + w - 8, y + 11)
  }
  if (p.awaiting) clip(ctx, x + 8, y + 4, CLIP_COLORS[p.awaiting])
  if (done) stamp(ctx, x + w - 24, y + h / 2 + 4)
  ctx.restore()
}

function clip(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.strokeStyle = color
  ctx.lineWidth = 3
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(x + 6, y + 40)
  ctx.lineTo(x + 6, y + 6)
  ctx.arc(x + 3, y + 6, 3, 0, Math.PI, true)
  ctx.lineTo(x, y + 34)
  ctx.arc(x + 4, y + 34, 4, Math.PI, 0, true)
  ctx.lineTo(x + 8, y + 12)
  ctx.stroke()
}

function stamp(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(-0.25)
  ctx.globalAlpha = 0.85
  ctx.strokeStyle = '#4f9a45'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(0, 0, 15, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = 4
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(-7, 1)
  ctx.lineTo(-2, 7)
  ctx.lineTo(8, -6)
  ctx.stroke()
  ctx.restore()
}

/** A pilha "+K" de uma coluna. */
export function paintPile(ctx: CanvasRenderingContext2D, cell: number, k: number, status: BoardItemStatus): void {
  const { x, y, w, h } = cellRect(cell)
  ctx.save()
  ctx.fillStyle = FACE_COLOR
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = '#e6dcc4'
  ctx.fillRect(x + 10, y + 2, w - 14, h - 4)
  ctx.fillStyle = '#efe5cd'
  ctx.fillRect(x + 5, y + 5, w - 12, h - 8)
  ctx.fillStyle = PAPER_COLORS[status]
  ctx.fillRect(x, y + 8, w - 12, h - 8)
  ctx.fillStyle = INK
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `800 30px ${FONT}`
  ctx.fillText(`+${k}`, x + (w - 12) / 2 - 62, y + h / 2 + 6)
  ctx.font = `600 19px ${FONT}`
  ctx.fillText(k === 1 ? 'mais 1 cartão' : `mais ${k} cartões`, x + (w - 12) / 2 + 30, y + h / 2 + 7)
  ctx.restore()
}
