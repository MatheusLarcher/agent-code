/**
 * Placas do projeto (CanvasTexture com mipmaps e anisotropia):
 * - 'floor': a placa no chão diante da ilha reservada (1024×256, a paleta clara
 *   do mockup v2) na COR DO PROJETO (projectColor.ts): véu, moldura, filete,
 *   anel do medalhão, o nome e o traço sob ele — identifica a ilha de longe;
 * - 'desk': a plaquinha da mesa ocupada (256×256): fundo e o medalhão com o
 *   ícone, no tom NEUTRO fixo (NEUTRAL) — nada colado no agente muda de cor.
 *
 * O ícone vem de `feed.projectIcons[cwd]`. No App ele é uma data URL (App.tsx,
 * "Icon found inside each project folder"), mas aceitamos também URL, caminho de
 * arquivo e emoji/glifo curto; sem ícone, a inicial.
 */
import { CanvasTexture, SRGBColorSpace } from 'three'
import { hslToRgb, parseHex, rgbToHsl, toHex } from '@shared/projectColor'
import { fileUrl } from '../fileUrl'
import { canvas2d } from './textures'

export type IconSource = { kind: 'image'; src: string } | { kind: 'glyph'; text: string } | { kind: 'initial'; text: string }

/** Inicial do nome (primeira letra ou dígito), maiúscula; "?" sem nenhuma. */
export function initialOf(name: string): string {
  const m = /[\p{L}\p{N}]/u.exec(name)
  return m ? m[0].toUpperCase() : '?'
}

/** Interpreta o ícone do projeto (caminho local vira file:///, pelo fileUrl). */
export function iconSource(icon: string | null | undefined, name: string): IconSource {
  const s = (icon ?? '').trim()
  if (!s) return { kind: 'initial', text: initialOf(name) }
  if (/^data:image\//i.test(s) || /^(https?|file|blob):/i.test(s)) return { kind: 'image', src: s }
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('\\\\')) return { kind: 'image', src: fileUrl(s) }
  // Emoji ou glifo curto (até 2 "letras" visíveis).
  if ([...s].length <= 4 && !/\s/.test(s)) return { kind: 'glyph', text: s }
  return { kind: 'initial', text: initialOf(name) }
}

/** Matiz estável por id (FNV-1a): o acento da tela do console da Central (screens.ts). Projeto usa a cor fixa (projectColor.ts). */
export function accentHue(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % 360
}

export const SIGN_W = 1024
export const SIGN_H = 256
const DESK_SIGN = 256

export type SignStyle = 'floor' | 'desk'

/** O tom neutro das placas (oliva/ardósia apagado, da paleta clara do mockup v2), igual para todos os projetos. */
export const NEUTRAL = {
  /** Placa do chão: o filete, a letra do medalhão e o anel dele. */
  bar: '#9aa192',
  ink: '#4f574a',
  ring: '#b0b6a8',
  /** Plaquinha da mesa: o degradê do fundo, o filete claro e a letra do medalhão. */
  top: '#7f877b',
  bottom: '#5f665c',
  edge: 'rgba(236, 239, 232, 0.6)',
  deskInk: '#4a5146'
} as const

export interface SignTexture {
  texture: CanvasTexture
  aspect: number
  dispose(): void
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Medalhão claro com o ícone (imagem recortada no círculo, glifo ou inicial em `ink`). */
function medallion(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, source: IconSource, img: HTMLImageElement | null, name: string, ink: string, ring: string | null, ringWidth = 0.08): void {
  ctx.fillStyle = '#f6f4ec'
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  if (ring) {
    ctx.strokeStyle = ring
    ctx.lineWidth = r * ringWidth
    ctx.stroke()
  }
  if (source.kind === 'image' && img && img.complete && img.naturalWidth > 0) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r * 0.86, 0, Math.PI * 2)
    ctx.clip()
    const s = Math.min((1.64 * r) / img.naturalWidth, (1.64 * r) / img.naturalHeight)
    const w = img.naturalWidth * s
    const h = img.naturalHeight * s
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h)
    ctx.restore()
    return
  }
  const text = source.kind === 'image' ? initialOf(name) : source.text
  ctx.fillStyle = ink
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = source.kind === 'glyph' ? `${Math.round(r * 1.1)}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif` : `bold ${Math.round(r * 1.2)}px "Segoe UI", sans-serif`
  ctx.fillText(text, cx, cy + r * 0.07)
}

/** `#rrggbb` + alfa → `rgba(...)`; hex inválido volta como veio. */
function alpha(hex: string, a: number): string {
  const c = parseHex(hex)
  return c ? `rgba(${c.r}, ${c.g}, ${c.b}, ${a})` : hex
}

/** A tinta do nome: o matiz do projeto, escuro o bastante para ler sobre a placa clara. */
export function floorInk(hex: string): string {
  const c = parseHex(hex)
  if (!c) return '#6f7a66'
  const hsl = rgbToHsl(c)
  return toHex(hslToRgb({ ...hsl, l: Math.min(hsl.l, 0.3) }))
}

/**
 * A placa do chão: fundo claro com um véu da cor do projeto vindo da esquerda,
 * moldura, filete e anel do medalhão na cor, o nome (maiúsculas, encolhendo até
 * caber) na tinta escura da mesma cor e um traço da cor sob ele. Sem cor, o tom NEUTRAL.
 */
function drawFloor(ctx: CanvasRenderingContext2D, source: IconSource, img: HTMLImageElement | null, name: string, accent: string | null): void {
  ctx.fillStyle = '#d4d7cc'
  ctx.fillRect(0, 0, SIGN_W, SIGN_H)
  if (accent) {
    const wash = ctx.createLinearGradient(0, 0, SIGN_W * 0.7, 0)
    wash.addColorStop(0, alpha(accent, 0.34))
    wash.addColorStop(1, alpha(accent, 0))
    ctx.fillStyle = wash
    roundRect(ctx, 12, 12, SIGN_W - 24, SIGN_H - 24, 18)
    ctx.fill()
  }
  ctx.strokeStyle = accent ? alpha(accent, 0.75) : '#c2c6b8'
  ctx.lineWidth = 6
  roundRect(ctx, 12, 12, SIGN_W - 24, SIGN_H - 24, 18)
  ctx.stroke()
  ctx.fillStyle = accent ?? NEUTRAL.bar
  roundRect(ctx, 32, 40, 20, SIGN_H - 80, 10)
  ctx.fill()
  const cx = 160
  const cy = SIGN_H / 2
  medallion(ctx, cx, cy, 78, source, img, name, accent ? floorInk(accent) : NEUTRAL.ink, accent ?? NEUTRAL.ring, accent ? 0.12 : 0.08)
  const left = cx + 78 + 44
  const maxW = SIGN_W - left - 56
  const label = name.toUpperCase()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  let size = 96
  ctx.font = `600 ${size}px "Segoe UI", sans-serif`
  while (size > 40 && ctx.measureText(label).width > maxW) {
    size -= 4
    ctx.font = `600 ${size}px "Segoe UI", sans-serif`
  }
  ctx.fillStyle = accent ? floorInk(accent) : '#6f7a66'
  ctx.fillText(label, left, cy - (accent ? 6 : -4), maxW)
  if (!accent) return
  // O traço sob o nome: da largura do texto, na cor do projeto.
  const textW = Math.min(maxW, ctx.measureText(label).width)
  ctx.fillStyle = accent
  roundRect(ctx, left, cy + size * 0.42, Math.max(60, textW), 10, 5)
  ctx.fill()
}

/** A plaquinha da mesa: fundo neutro, filete claro e o medalhão do ícone. */
function drawDesk(ctx: CanvasRenderingContext2D, source: IconSource, img: HTMLImageElement | null, name: string): void {
  const g = ctx.createLinearGradient(0, 0, 0, DESK_SIGN)
  g.addColorStop(0, NEUTRAL.top)
  g.addColorStop(1, NEUTRAL.bottom)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, DESK_SIGN, DESK_SIGN)
  ctx.strokeStyle = NEUTRAL.edge
  ctx.lineWidth = 8
  roundRect(ctx, 14, 14, DESK_SIGN - 28, DESK_SIGN - 28, 22)
  ctx.stroke()
  medallion(ctx, DESK_SIGN / 2, DESK_SIGN / 2, 82, source, img, name, NEUTRAL.deskInk, null)
}

/**
 * Desenha a placa. `accent` (a cor do projeto, `#rrggbb`) pinta só a do chão; a
 * da mesa fica no tom neutro. A imagem do ícone carrega de forma assíncrona: quando chega,
 * redesenha e chama `onUpdate` (o motor agenda um quadro). Imagem com erro cai
 * na inicial.
 */
export function createSignTexture(name: string, icon: string | null, accent: string | null, anisotropy: number, onUpdate: () => void, style: SignStyle = 'floor'): SignTexture {
  const w = style === 'floor' ? SIGN_W : DESK_SIGN
  const h = style === 'floor' ? SIGN_H : DESK_SIGN
  const { canvas, ctx } = canvas2d(w, h)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = anisotropy
  let source = iconSource(icon, name)
  let img: HTMLImageElement | null = null
  let disposed = false

  const draw = (): void => {
    if (!ctx) return
    if (style === 'floor') drawFloor(ctx, source, img, name, accent)
    else drawDesk(ctx, source, img, name)
    texture.needsUpdate = true
  }

  if (source.kind === 'image' && ctx && typeof Image !== 'undefined') {
    img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      if (disposed) return
      draw()
      onUpdate()
    }
    img.onerror = () => {
      if (disposed) return
      source = { kind: 'initial', text: initialOf(name) }
      draw()
      onUpdate()
    }
    img.src = source.src
  }
  draw()

  return {
    texture,
    aspect: w / h,
    dispose() {
      disposed = true
      if (img) {
        img.onload = null
        img.onerror = null
      }
      texture.dispose()
    }
  }
}
