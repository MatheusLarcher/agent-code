/**
 * A faixa do título no alto do kanban (canvas 2D, na textura do quadro): o
 * ícone e o nome do projeto que está na parede, à esquerda; à direita, uma aba
 * redonda por projeto com quadro (ícone ou inicial na cor do projeto), a do
 * projeto mostrado com anel. A geometria das abas é a de boardLayout.ts
 * (tabX/tabAt): o clique acha a aba pelo ponto da face.
 *
 * Ícone de imagem (data URL, arquivo) carrega uma vez e fica em cache; quando
 * chega, `iconsVersion` sobe e quem pinta redesenha (`onIcon` pede um quadro).
 */
import { accentHue, iconSource, initialOf } from '../sign'
import { FACE_W, MAX_TABS, TAB_D, tabX } from './boardLayout'

export interface BoardTitleInfo {
  id: string
  name: string
  icon: string | null
}

const FONT = '"Segoe UI", system-ui, sans-serif'
const INK = '#2d2721'
const images = new Map<string, HTMLImageElement | null>()
let version = 0
let listener: () => void = () => {}

/** Sobe quando um ícone de imagem termina de carregar (quem pinta compara e redesenha). */
export function iconsVersion(): number {
  return version
}

/** Quem é avisado quando um ícone chega (a cena pede um quadro). */
export function onIcon(fn: () => void): void {
  listener = fn
}

function imageOf(src: string): HTMLImageElement | null {
  if (images.has(src)) return images.get(src) ?? null
  if (typeof Image === 'undefined') return null
  const img = new Image()
  images.set(src, null)
  img.onload = () => {
    images.set(src, img)
    version++
    listener()
  }
  img.src = src
  return null
}

/** O ícone do projeto num círculo de raio `r` (imagem recortada, glifo ou a inicial na cor do projeto). */
function icon(ctx: CanvasRenderingContext2D, p: BoardTitleInfo, cx: number, cy: number, r: number): void {
  const src = iconSource(p.icon, p.name)
  const img = src.kind === 'image' ? imageOf(src.src) : null
  ctx.fillStyle = img || src.kind === 'glyph' ? '#f6f4ec' : `hsl(${accentHue(p.id)} 42% 46%)`
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  if (img) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r * 0.86, 0, Math.PI * 2)
    ctx.clip()
    const s = Math.min((1.7 * r) / img.naturalWidth, (1.7 * r) / img.naturalHeight)
    ctx.drawImage(img, cx - (img.naturalWidth * s) / 2, cy - (img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s)
    ctx.restore()
    return
  }
  const text = src.kind === 'image' ? initialOf(p.name) : src.text
  ctx.fillStyle = src.kind === 'glyph' ? INK : '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = src.kind === 'glyph' ? `${Math.round(r * 1.15)}px "Segoe UI Emoji", ${FONT}` : `700 ${Math.round(r * 1.1)}px ${FONT}`
  ctx.fillText(text, cx, cy + r * 0.06)
}

/**
 * Pinta a faixa (`h` px de altura, `w` de largura) no alto da face: o projeto
 * mostrado e as abas. Sem projeto, "Quadro" sem ícone.
 */
export function paintTitle(ctx: CanvasRenderingContext2D, w: number, h: number, title: BoardTitleInfo | null, tabs: readonly BoardTitleInfo[]): void {
  const px = w / FACE_W
  ctx.fillStyle = 'rgba(80,60,40,0.10)'
  ctx.fillRect(6, 6, w - 12, h - 8)
  const cy = h / 2 + 2
  const r = h * 0.34
  let left = 22
  if (title) {
    icon(ctx, title, left + r, cy, r)
    left += r * 2 + 16
  }
  const n = Math.min(tabs.length, MAX_TABS)
  const tabsLeft = n > 0 ? w / 2 + tabX(0, tabs.length) * px - (TAB_D * px) / 2 - 20 : w - 20
  ctx.fillStyle = INK
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  let size = 34
  const name = title?.name ?? 'Quadro'
  ctx.font = `700 ${size}px ${FONT}`
  while (size > 18 && ctx.measureText(name).width > tabsLeft - left) {
    size -= 2
    ctx.font = `700 ${size}px ${FONT}`
  }
  ctx.fillText(name, left, cy, Math.max(10, tabsLeft - left))
  for (let i = 0; i < n; i++) {
    const t = tabs[i]
    const x = w / 2 + tabX(i, tabs.length) * px
    const tr = (TAB_D * px) / 2
    if (t.id === title?.id) {
      ctx.strokeStyle = `hsl(${accentHue(t.id)} 50% 38%)`
      ctx.lineWidth = 5
      ctx.beginPath()
      ctx.arc(x, cy, tr + 5, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.globalAlpha = t.id === title?.id ? 1 : 0.72
    icon(ctx, t, x, cy, tr)
    ctx.globalAlpha = 1
  }
}
