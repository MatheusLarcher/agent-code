/**
 * A imagem do projetor, desenhada em canvas 2D: uma janela de navegador (aba
 * com o título e a letra do site, barra com a URL) ou um celular (moldura com
 * a câmera, o nome do app ao lado), com a página dentro — o quadro real do
 * navegador da conversa, a página falsa da demo ou, sem quadro, o esqueleto de
 * uma página — e o selo "● AO VIVO" quando é ao vivo. Na TV, por cima: a
 * faixa do chamado, o teste ao vivo no quadrinho (PiP) e o "+N esperando"; e,
 * sem página, o placar (tvPaint.ts). Puro canvas, sem three: quem chama decide
 * quando (a textura da TV, o espelho do foco).
 */
import { chatPalette, ellipsize, roundRect } from './chatPaint'
import type { DeviceKind } from './projectorUse'
import { paintBanner, paintScore, paintWaiting, type ScoreData } from './tvPaint'

/** A página dentro da moldura: tamanho natural (a proporção) e quem a desenha. */
export interface PageImage {
  width: number
  height: number
  draw(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void
}

export interface ProjectorView {
  kind: DeviceKind
  url: string
  title: string
  live: boolean
  /** Projeto da sala (o canto da aba / embaixo do app). */
  project: string
  image: PageImage | null
  /** O placar no lugar da página (a TV ociosa). */
  score?: ScoreData | null
  /** A faixa do chamado: quem chama e a mensagem. */
  banner?: { title: string; text: string } | null
  /** O teste ao vivo no quadrinho do canto (com um chamado na tela). */
  pip?: ProjectorView | null
  /** "+N esperando" (0 = sem selo). */
  waiting?: number
}

/** Tamanho da textura do telão (16:9, a proporção da tela da sala). */
export const PROJ_W = 640
export const PROJ_H = 360

type Ctx = CanvasRenderingContext2D

/** "https://localhost:5173/carrinho?x" → "localhost:5173/carrinho?x". */
export function shortUrl(url: string): string {
  return url.replace(/^[a-z][\w+.-]*:\/\//i, '').replace(/\/$/, '')
}

/** A letra do "favicon": do título ou do host. */
export function siteLetter(title: string, url: string): string {
  const host = shortUrl(url).replace(/^www\./, '')
  const m = /[\p{L}\p{N}]/u.exec(title) ?? /[\p{L}\p{N}]/u.exec(host)
  return m ? m[0].toUpperCase() : '•'
}

/** A página que cabe inteira no retângulo (sem distorcer), centrada. */
function contain(img: PageImage, x: number, y: number, w: number, h: number): [number, number, number, number] {
  const k = Math.min(w / Math.max(1, img.width), h / Math.max(1, img.height))
  const iw = img.width * k
  const ih = img.height * k
  return [x + (w - iw) / 2, y + (h - ih) / 2, iw, ih]
}

/** Esqueleto de página: cabeçalho, título, destaque e três cartões. */
function skeleton(ctx: Ctx, x: number, y: number, w: number, h: number, title: string, accent: string): void {
  ctx.fillStyle = '#f6f7f9'
  ctx.fillRect(x, y, w, h)
  ctx.fillStyle = accent
  ctx.fillRect(x, y, w, h * 0.12)
  const p = chatPalette()
  ctx.fillStyle = '#ffffff'
  ctx.font = `600 ${Math.round(h * 0.055)}px ${p.font}`
  ctx.fillText(ellipsize(ctx, title || 'Carregando…', w * 0.6), x + w * 0.05, y + h * 0.06)
  ctx.fillStyle = '#dfe3ea'
  roundRect(ctx, x + w * 0.05, y + h * 0.18, w * 0.9, h * 0.3, 6)
  ctx.fill()
  ctx.fillStyle = '#c9cfd9'
  for (let i = 0; i < 3; i++) {
    roundRect(ctx, x + w * (0.05 + i * 0.31), y + h * 0.54, w * 0.28, h * 0.26, 6)
    ctx.fill()
  }
  ctx.fillStyle = '#e4e7ec'
  for (let i = 0; i < 2; i++) ctx.fillRect(x + w * 0.05, y + h * (0.85 + i * 0.06), w * (0.7 - i * 0.25), h * 0.025)
}

/** O selo "● AO VIVO"; `x` é a borda direita (align 'right') ou a esquerda. */
function liveBadge(ctx: Ctx, x0: number, top: number, scale: number, align: 'left' | 'right' = 'right'): void {
  const p = chatPalette()
  ctx.font = `700 ${Math.round(12 * scale)}px ${p.font}`
  const label = 'AO VIVO'
  const tw = ctx.measureText(label).width
  const bw = tw + 30 * scale
  const bh = 22 * scale
  const x = align === 'right' ? x0 - bw : x0
  ctx.fillStyle = 'rgba(12, 12, 16, 0.72)'
  roundRect(ctx, x, top, bw, bh, bh / 2)
  ctx.fill()
  ctx.fillStyle = '#ff4d4f'
  ctx.beginPath()
  ctx.arc(x + 11 * scale, top + bh / 2, 4.5 * scale, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.fillText(label, x + 20 * scale, top + bh / 2 + 0.5)
}

function paintBrowser(ctx: Ctx, w: number, h: number, v: ProjectorView, s: number): void {
  const p = chatPalette()
  const tabH = 28 * s
  const barH = 30 * s
  // Moldura escura: a faixa das abas e a da URL.
  ctx.fillStyle = '#202226'
  ctx.fillRect(0, 0, w, tabH + barH)
  ctx.fillStyle = '#34373d'
  roundRect(ctx, 10 * s, 5 * s, Math.min(w * 0.42, 260 * s), tabH, [8 * s, 8 * s, 0, 0])
  ctx.fill()
  ctx.fillStyle = p.accent
  ctx.beginPath()
  ctx.arc(24 * s, 5 * s + tabH / 2, 7 * s, 0, Math.PI * 2)
  ctx.fill()
  ctx.font = `700 ${Math.round(9 * s)}px ${p.font}`
  ctx.fillStyle = '#1a1a1a'
  const letter = siteLetter(v.title, v.url)
  ctx.fillText(letter, 24 * s - ctx.measureText(letter).width / 2, 5 * s + tabH / 2 + 0.5)
  ctx.font = `${Math.round(11.5 * s)}px ${p.font}`
  ctx.fillStyle = '#e8eaed'
  ctx.fillText(ellipsize(ctx, v.title || shortUrl(v.url) || 'Nova aba', Math.min(w * 0.42, 260 * s) - 40 * s), 38 * s, 5 * s + tabH / 2)
  if (v.project) {
    ctx.fillStyle = '#9aa0a6'
    ctx.font = `${Math.round(10.5 * s)}px ${p.font}`
    const t = ellipsize(ctx, v.project, w * 0.3)
    ctx.fillText(t, w - 12 * s - ctx.measureText(t).width, 5 * s + tabH / 2)
  }
  // Barra de endereço com o cadeado.
  ctx.fillStyle = '#34373d'
  ctx.fillRect(0, tabH + 4 * s, w, barH - 4 * s)
  ctx.fillStyle = '#1c1d20'
  roundRect(ctx, 12 * s, tabH + 8 * s, w - 24 * s, barH - 12 * s, (barH - 12 * s) / 2)
  ctx.fill()
  ctx.fillStyle = '#9aa0a6'
  ctx.fillRect(24 * s, tabH + 15 * s, 7 * s, 6 * s)
  ctx.strokeStyle = '#9aa0a6'
  ctx.lineWidth = 1.4 * s
  ctx.beginPath()
  ctx.arc(27.5 * s, tabH + 15 * s, 2.6 * s, Math.PI, 0)
  ctx.stroke()
  ctx.font = `${Math.round(11.5 * s)}px ${p.font}`
  ctx.fillStyle = '#e8eaed'
  ctx.fillText(ellipsize(ctx, shortUrl(v.url) || 'about:blank', w - 70 * s), 40 * s, tabH + 8 * s + (barH - 12 * s) / 2)
  // A página.
  const top = tabH + barH
  const ph = h - top
  if (v.image) {
    ctx.fillStyle = '#0d0e10'
    ctx.fillRect(0, top, w, ph)
    const [x, y, iw, ih] = contain(v.image, 0, top, w, ph)
    v.image.draw(ctx, x, y, iw, ih)
  } else {
    skeleton(ctx, 0, top, w, ph, v.title, '#3b6fd8')
  }
  if (v.live) liveBadge(ctx, w - 10 * s, top + 10 * s, s)
}

function paintPhone(ctx: Ctx, w: number, h: number, v: ProjectorView, s: number): void {
  const p = chatPalette()
  const g = ctx.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, '#1d2130')
  g.addColorStop(1, '#0d0f15')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  const aspect = v.image ? v.image.width / Math.max(1, v.image.height) : 9 / 19.5
  const ph = h - 36 * s
  const pw = ph * Math.min(0.75, Math.max(0.4, aspect))
  const px = w * 0.3 - pw / 2
  const py = 18 * s
  ctx.fillStyle = '#0a0a0c'
  roundRect(ctx, px - 7 * s, py - 7 * s, pw + 14 * s, ph + 14 * s, 22 * s)
  ctx.fill()
  ctx.strokeStyle = '#4a4e58'
  ctx.lineWidth = 2 * s
  roundRect(ctx, px - 7 * s, py - 7 * s, pw + 14 * s, ph + 14 * s, 22 * s)
  ctx.stroke()
  ctx.save()
  roundRect(ctx, px, py, pw, ph, 14 * s)
  ctx.clip()
  if (v.image) {
    ctx.fillStyle = '#000000'
    ctx.fillRect(px, py, pw, ph)
    const [x, y, iw, ih] = contain(v.image, px, py, pw, ph)
    v.image.draw(ctx, x, y, iw, ih)
  } else {
    skeleton(ctx, px, py, pw, ph, v.title, '#2e9d6a')
  }
  ctx.restore()
  ctx.fillStyle = '#1b1c20'
  ctx.beginPath()
  ctx.arc(px + pw / 2, py + 9 * s, 3.5 * s, 0, Math.PI * 2)
  ctx.fill()
  // Ao lado: o app, o aparelho e o selo.
  const tx = w * 0.56
  ctx.fillStyle = '#ffffff'
  ctx.font = `700 ${Math.round(24 * s)}px ${p.font}`
  ctx.fillText(ellipsize(ctx, v.title || 'App Android', w - tx - 16 * s), tx, h * 0.38)
  ctx.fillStyle = '#9aa0a6'
  ctx.font = `${Math.round(13 * s)}px ${p.font}`
  ctx.fillText(ellipsize(ctx, v.project ? `Android · ${v.project}` : 'Android', w - tx - 16 * s), tx, h * 0.38 + 28 * s)
  if (v.live) liveBadge(ctx, tx, h * 0.38 + 48 * s, s, 'left')
}

/** Desenha a imagem do telão em `w`×`h` (o desenho é o mesmo em qualquer tamanho: `w`/PROJ_W é a escala). */
export function paintProjector(ctx: Ctx, w: number, h: number, view: ProjectorView): void {
  const s = w / PROJ_W
  ctx.save()
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  if (view.score) paintScore(ctx, w, h, view.score, s)
  else if (view.kind === 'android') paintPhone(ctx, w, h, view, s)
  else paintBrowser(ctx, w, h, view, s)
  if (view.banner) paintBanner(ctx, w, view.banner, s)
  if (view.pip) {
    // O quadrinho embaixo à direita, com moldura.
    const pw = w * 0.32
    const ph = (pw * PROJ_H) / PROJ_W
    const x = w - pw - 10 * s
    const y = h - ph - 10 * s
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(x - 2 * s, y - 2 * s, pw + 4 * s, ph + 4 * s)
    ctx.translate(x, y)
    paintProjector(ctx, pw, ph, { ...view.pip, pip: null, banner: null, waiting: 0, score: null })
    ctx.translate(-x, -y)
  }
  if (view.waiting) paintWaiting(ctx, h, view.waiting, s)
  ctx.restore()
}
