/**
 * O chat encolhido desenhado em canvas 2D — o visual do chat (styles.css) em
 * miniatura, para a textura do monitor do agente:
 *   pedido do usuário  balão à direita na cor de destaque, texto escuro;
 *   narração           texto pequeno, apagado e em itálico, sem balão;
 *   resposta final     balão escuro (--bg-3) à esquerda;
 *   pensamento         borda tracejada, itálico;
 *   ferramenta         a linha recolhida do ToolCard: ▸, verbo em negrito,
 *                      detalhe, +N/−M coloridos e a pílula running…/done/error
 *                      nas cores do chat (vermelho na borda quando falhou);
 *   nota               centralizada, pequena (erro em vermelho).
 * O mais novo fica embaixo, como no chat; o que não cabe sai por cima. Cores e
 * fontes vêm das variáveis do styles.css (lidas uma vez; sem CSS, os mesmos
 * valores fixos). Só roda quando a página muda — nada por quadro.
 */
import type { ChatLine, ChatPage } from './chatPage'

export interface ChatPalette {
  bg: string
  bg2: string
  bg3: string
  line: string
  text: string
  muted: string
  accent: string
  accentDim: string
  ok: string
  err: string
  font: string
  mono: string
}

const FALLBACK: ChatPalette = {
  bg: '#1f1e1d',
  bg2: '#262624',
  bg3: '#302e2c',
  line: '#3a3836',
  text: '#e8e6e3',
  muted: '#a3a09b',
  accent: '#d97757',
  accentDim: '#b9603f',
  ok: '#7fae6f',
  err: '#d97070',
  font: '-apple-system, "Segoe UI", system-ui, sans-serif',
  mono: 'ui-monospace, "Cascadia Mono", Consolas, monospace'
}

const VARS: Array<[keyof ChatPalette, string]> = [
  ['bg', '--bg'], ['bg2', '--bg-2'], ['bg3', '--bg-3'], ['line', '--line'], ['text', '--text'], ['muted', '--muted'],
  ['accent', '--accent'], ['accentDim', '--accent-dim'], ['ok', '--ok'], ['err', '--err'], ['font', '--font']
]

let cached: ChatPalette | null = null

/** As cores e a fonte do chat (variáveis do :root), lidas uma vez. */
export function chatPalette(): ChatPalette {
  if (cached) return cached
  const p = { ...FALLBACK }
  try {
    const cs = getComputedStyle(document.documentElement)
    for (const [key, name] of VARS) {
      const v = cs.getPropertyValue(name).trim()
      if (v) p[key] = v
    }
  } catch {
    // Sem DOM: os valores fixos (os mesmos do styles.css).
  }
  return (cached = p)
}

type Ctx = CanvasRenderingContext2D

/** Retângulo arredondado; `r` = [sup. esq., sup. dir., inf. dir., inf. esq.]. */
export function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number | [number, number, number, number]): void {
  const [a, b, c, d] = typeof r === 'number' ? [r, r, r, r] : r
  ctx.beginPath()
  ctx.moveTo(x + a, y)
  ctx.arcTo(x + w, y, x + w, y + h, b)
  ctx.arcTo(x + w, y + h, x, y + h, c)
  ctx.arcTo(x, y + h, x, y, d)
  ctx.arcTo(x, y, x + w, y, a)
  ctx.closePath()
}

/** Corta `text` em `max` px com "…". */
export function ellipsize(ctx: Ctx, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid
    else hi = mid - 1
  }
  return `${text.slice(0, lo).trimEnd()}…`
}

/** Quebra em linhas de até `max` px (no máximo `lines`; a última com "…" se sobrar texto). */
export function wrapText(ctx: Ctx, text: string, max: number, lines: number): string[] {
  const out: string[] = []
  let cur = ''
  const words = text.split(' ')
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i]
    if (ctx.measureText(next).width <= max || !cur) {
      cur = next
      continue
    }
    if (out.length === lines - 1) return [...out, ellipsize(ctx, `${cur} ${words.slice(i).join(' ')}`, max)]
    out.push(ellipsize(ctx, cur, max))
    cur = words[i]
  }
  if (cur) out.push(ellipsize(ctx, cur, max))
  return out
}

const PAD = 9
const GAP = 6
const HEAD = 26
const BUBBLE_MAX = 0.86

interface Box {
  h: number
  paint(y: number): void
}

const font = (p: ChatPalette, size: number, weight = '', style = ''): string => `${style} ${weight} ${size}px ${p.font}`.trim()
const mono = (p: ChatPalette, size: number, weight = ''): string => `${weight} ${size}px ${p.mono}`.trim()

/** Balão de texto (pedido, resposta, pensamento) ou texto solto (narração). */
function textBox(ctx: Ctx, p: ChatPalette, l: Extract<ChatLine, { text: string }>, x0: number, w: number): Box {
  const bubble = l.kind !== 'narration'
  const size = l.kind === 'user' || l.kind === 'answer' ? 13 : 12
  const f = font(p, size, '', l.kind === 'narration' || l.kind === 'thinking' ? 'italic' : '')
  ctx.font = f
  const padX = bubble ? 9 : 3
  const maxLines = l.kind === 'answer' ? 4 : l.kind === 'user' ? 3 : 2
  const rows = wrapText(ctx, l.text, w * BUBBLE_MAX - padX * 2, maxLines)
  const lineH = size + 4
  const textW = Math.max(...rows.map((r) => ctx.measureText(r).width), 8)
  const bw = textW + padX * 2
  const h = rows.length * lineH + (bubble ? 10 : 2)
  const bx = l.kind === 'user' ? x0 + w - bw : x0
  return {
    h,
    paint(y) {
      if (l.kind === 'user' || l.kind === 'answer') {
        ctx.fillStyle = l.kind === 'user' ? p.accent : p.bg3
        roundRect(ctx, bx, y, bw, h, l.kind === 'user' ? [9, 9, 3, 9] : [9, 9, 9, 3])
        ctx.fill()
      } else if (l.kind === 'thinking') {
        ctx.strokeStyle = p.line
        ctx.setLineDash([4, 3])
        roundRect(ctx, bx + 0.5, y + 0.5, bw - 1, h - 1, 9)
        ctx.stroke()
        ctx.setLineDash([])
      }
      ctx.font = f
      ctx.fillStyle = l.kind === 'user' ? '#1a1a1a' : l.kind === 'answer' ? p.text : p.muted
      ctx.globalAlpha = l.kind === 'narration' ? 0.78 : 1
      rows.forEach((r, i) => ctx.fillText(r, bx + padX, y + (bubble ? 5 : 1) + i * lineH + lineH / 2))
      ctx.globalAlpha = 1
    }
  }
}

/** A linha recolhida do ToolCard: abraça o conteúdo, a pílula no fim. */
function toolBox(ctx: Ctx, p: ChatPalette, l: Extract<ChatLine, { kind: 'tool' }>, x0: number, w: number): Box {
  const h = 24
  const verbFont = mono(p, l.skill ? 13 : 12, '700')
  const detailFont = mono(p, 11.5, l.skill ? '600' : '')
  const diffFont = mono(p, 11, '700')
  const pillFont = font(p, 10.5)
  ctx.font = verbFont
  const verbW = ctx.measureText(l.verb).width
  ctx.font = diffFont
  const add = l.added > 0 ? `+${l.added}` : ''
  const del = l.removed > 0 ? `−${l.removed}` : ''
  const diffW = (add ? ctx.measureText(add).width : 0) + (del ? ctx.measureText(del).width : 0) + (add && del ? 5 : 0)
  ctx.font = pillFont
  const pillW = ctx.measureText(l.badge.text).width + 14
  const fixed = 9 + 9 + 6 + verbW + 6 + (diffW ? diffW + 6 : 0) + pillW + 9
  ctx.font = detailFont
  const detail = l.detail ? ellipsize(ctx, l.detail, Math.max(0, w - fixed - 6)) : ''
  const detailW = detail ? ctx.measureText(detail).width + 6 : 0
  const cw = Math.min(w, fixed + detailW)
  const pill = l.badge.kind === 'run' ? p.accent : l.badge.kind === 'ok' ? p.ok : p.err
  return {
    h,
    paint(y) {
      const mid = y + h / 2
      ctx.fillStyle = p.bg2
      roundRect(ctx, x0, y, cw, h, 6)
      ctx.fill()
      if (l.skill) {
        ctx.globalAlpha = 0.08
        ctx.fillStyle = p.accent
        ctx.fill()
        ctx.globalAlpha = 1
      }
      ctx.strokeStyle = l.err ? p.err : l.skill ? p.accentDim : p.line
      ctx.lineWidth = 1
      roundRect(ctx, x0 + 0.5, y + 0.5, cw - 1, h - 1, 6)
      ctx.stroke()
      let x = x0 + 9
      ctx.font = font(p, 9)
      ctx.fillStyle = p.muted
      ctx.fillText('▸', x, mid)
      x += 9 + 6
      ctx.font = verbFont
      ctx.fillStyle = l.skill ? p.accent : p.text
      ctx.fillText(l.verb, x, mid)
      x += verbW + 6
      if (detail) {
        ctx.font = detailFont
        ctx.fillStyle = l.skill ? p.accent : p.muted
        ctx.fillText(detail, x, mid)
        x += detailW
      }
      if (diffW) {
        ctx.font = diffFont
        if (add) {
          ctx.fillStyle = p.ok
          ctx.fillText(add, x, mid)
          x += ctx.measureText(add).width + 5
        }
        if (del) {
          ctx.fillStyle = p.err
          ctx.fillText(del, x, mid)
        }
      }
      const px = x0 + cw - 9 - pillW
      ctx.globalAlpha = 0.17
      ctx.fillStyle = pill
      roundRect(ctx, px, y + 4.5, pillW, h - 9, (h - 9) / 2)
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.font = pillFont
      ctx.fillStyle = pill
      ctx.fillText(l.badge.text, px + 7, mid)
    }
  }
}

function noteBox(ctx: Ctx, p: ChatPalette, l: Extract<ChatLine, { kind: 'note' }>, x0: number, w: number): Box {
  const f = font(p, 11)
  ctx.font = f
  const text = ellipsize(ctx, l.text, w - 20)
  const tw = ctx.measureText(text).width
  return {
    h: 16,
    paint(y) {
      ctx.font = f
      ctx.fillStyle = l.err ? p.err : p.muted
      ctx.fillText(text, x0 + (w - tw) / 2, y + 8)
    }
  }
}

function boxOf(ctx: Ctx, p: ChatPalette, l: ChatLine, x0: number, w: number): Box {
  if (l.kind === 'tool') return toolBox(ctx, p, l, x0, w)
  if (l.kind === 'note') return noteBox(ctx, p, l, x0, w)
  return textBox(ctx, p, l, x0, w)
}

/** O "digitando" do chat: três pontos num balão escuro. */
function typing(ctx: Ctx, p: ChatPalette, x: number, y: number): void {
  ctx.fillStyle = p.bg3
  roundRect(ctx, x, y, 40, 20, [9, 9, 9, 3])
  ctx.fill()
  ctx.fillStyle = p.muted
  for (let i = 0; i < 3; i++) {
    ctx.globalAlpha = 0.45 + 0.25 * i
    ctx.beginPath()
    ctx.arc(x + 11 + i * 9, y + 10, 2.6, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

/** Desenha a página inteira em `w`×`h` (unidades do canvas; quem chama põe a escala). `accent` = cor da sala. */
export function paintChat(ctx: Ctx, page: ChatPage, accent: string, w: number, h: number): void {
  const p = chatPalette()
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = p.bg
  ctx.fillRect(0, 0, w, h)
  const x0 = PAD
  const bw = w - PAD * 2
  const last = page.lines[page.lines.length - 1]
  const runningTool = last?.kind === 'tool' && last.badge.kind === 'run'
  let y = h - PAD
  if (page.busy && !runningTool) {
    y -= 20
    typing(ctx, p, x0, y)
    y -= GAP
  }
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, HEAD, w, h - HEAD)
  ctx.clip()
  for (let i = page.lines.length - 1; i >= 0 && y > HEAD; i--) {
    const box = boxOf(ctx, p, page.lines[i], x0, bw)
    y -= box.h
    box.paint(y)
    y -= GAP
  }
  ctx.restore()
  // Cabeçalho: o título da conversa, com a cor da sala embaixo.
  ctx.fillStyle = p.bg2
  ctx.fillRect(0, 0, w, HEAD)
  ctx.fillStyle = accent
  ctx.fillRect(0, HEAD - 2, w, 2)
  ctx.font = font(p, 12.5, '600')
  ctx.fillStyle = p.text
  ctx.fillText(ellipsize(ctx, page.title || 'Conversa', w - PAD * 2), PAD, HEAD / 2 - 1)
}
