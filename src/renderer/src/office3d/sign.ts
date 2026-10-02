/**
 * Placa do projeto na parede do fundo de cada sala: fundo na cor de destaque
 * da sala, ícone do projeto e nome. CanvasTexture em alta resolução (1024×256)
 * com mipmaps e anisotropia, nítida de perto e legível de longe.
 *
 * O ícone vem de `OfficeRoomModel.icon` (feed.projectIcons[cwd]). No App ele é
 * uma data URL (App.tsx, "Icon found inside each project folder"), mas aceitamos
 * também URL, caminho de arquivo e emoji/glifo curto; sem ícone, a inicial.
 */
import { CanvasTexture, SRGBColorSpace } from 'three'
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

/** Matiz estável por id (FNV-1a), para a cor de destaque da sala. */
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

/**
 * Desenha a placa. A imagem do ícone carrega de forma assíncrona: quando chega,
 * redesenha e chama `onUpdate` (o motor agenda um quadro). Imagem com erro cai
 * na inicial.
 */
export function createSignTexture(name: string, icon: string | null, accentId: string, anisotropy: number, onUpdate: () => void): SignTexture {
  const { canvas, ctx } = canvas2d(SIGN_W, SIGN_H)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = anisotropy
  const hue = accentHue(accentId)
  let source = iconSource(icon, name)
  let img: HTMLImageElement | null = null
  let disposed = false

  const draw = (): void => {
    if (!ctx) return
    const g = ctx.createLinearGradient(0, 0, 0, SIGN_H)
    g.addColorStop(0, `hsl(${hue} 46% 30%)`)
    g.addColorStop(1, `hsl(${hue} 52% 19%)`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, SIGN_W, SIGN_H)
    // Filete interno e brilho no topo.
    ctx.strokeStyle = `hsla(${hue} 70% 75% / 0.55)`
    ctx.lineWidth = 6
    roundRect(ctx, 14, 14, SIGN_W - 28, SIGN_H - 28, 22)
    ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,0.06)'
    ctx.fillRect(20, 20, SIGN_W - 40, 60)
    // Medalhão do ícone.
    const cx = 140
    const cy = SIGN_H / 2
    const r = 86
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.beginPath()
    ctx.arc(cx + 4, cy + 6, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#f6f1e7'
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()
    if (source.kind === 'image' && img && img.complete && img.naturalWidth > 0) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(cx, cy, r - 10, 0, Math.PI * 2)
      ctx.clip()
      const s = Math.min((2 * (r - 14)) / img.naturalWidth, (2 * (r - 14)) / img.naturalHeight)
      const w = img.naturalWidth * s
      const h = img.naturalHeight * s
      ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h)
      ctx.restore()
    } else {
      const text = source.kind === 'image' ? initialOf(name) : source.text
      ctx.fillStyle = `hsl(${hue} 50% 30%)`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = source.kind === 'glyph' ? '96px "Segoe UI Emoji", "Apple Color Emoji", sans-serif' : 'bold 104px "Segoe UI", sans-serif'
      ctx.fillText(text, cx, cy + 6)
    }
    // Nome do projeto, encolhendo a fonte até caber.
    const left = cx + r + 44
    const maxW = SIGN_W - left - 50
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    let size = 104
    ctx.font = `bold ${size}px "Segoe UI", sans-serif`
    while (size > 40 && ctx.measureText(name).width > maxW) {
      size -= 4
      ctx.font = `bold ${size}px "Segoe UI", sans-serif`
    }
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.fillText(name, left + 3, cy + 5, maxW)
    ctx.fillStyle = '#fbf6ec'
    ctx.fillText(name, left, cy, maxW)
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
    aspect: SIGN_W / SIGN_H,
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
