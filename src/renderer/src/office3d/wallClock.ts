/**
 * Relógio de parede do escritório (three): um "flip clock" de mesa pendurado na
 * parede do fundo, entre os quadros do lounge e o kanban. Moldura de carvalho
 * com friso de latão; na face, quatro cartões grafite com os dígitos creme
 * (a dobra no meio e as dobradiças), os dois-pontos de latão, a data e uma
 * saudação pela hora, e a barra do dia (sálvia, das 0h às 24h) com um ponto
 * de latão na hora atual. Mostra a hora local; só redesenha quando o minuto
 * muda (confere a cada CHECK_MS) e pede um quadro (`onDirty`). `dispose()`
 * para o relógio e libera textura, material e geometria.
 */
import { CanvasTexture, Mesh, MeshLambertMaterial, PlaneGeometry, SRGBColorSpace, type Group } from 'three'
import { box } from './decorUtil'
import type { Kit } from './kit'
import { BACK_FACE_Z } from './officePlan'
import { tagLod } from './roomLod'
import { canvas2d } from './textures'

/** Onde fica: centro na parede do fundo (m). */
export const CLOCK = { x: -2.85, y: 2.08, w: 1.04, h: 0.5 } as const
const CHECK_MS = 5000
const TEX_W = 1024
const TEX_H = 436

const DAYS = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB']
const MONTHS = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ']

export interface ClockFace {
  hh: string
  mm: string
  /** "SEG · 05 OUT" */
  date: string
  greeting: string
  /** Quanto do dia já passou (0..1). */
  day: number
  /** Muda quando o desenho muda (minuto e dia). */
  key: string
}

/** O que a face mostra no instante `d` (hora local). Puro. */
export function clockFace(d: Date): ClockFace {
  const h = d.getHours()
  const m = d.getMinutes()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const greeting = h >= 5 && h < 12 ? 'bom dia' : h >= 12 && h < 18 ? 'boa tarde' : 'boa noite'
  return {
    hh: pad(h),
    mm: pad(m),
    date: `${DAYS[d.getDay()]} · ${pad(d.getDate())} ${MONTHS[d.getMonth()]}`,
    greeting,
    day: (h * 60 + m) / 1440,
    key: `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${h}:${m}`
  }
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

/** Um cartão flip: metades com luz de cima, a dobra escura, as dobradiças e o dígito. */
function card(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, digit: string): void {
  const top = ctx.createLinearGradient(0, y, 0, y + h / 2)
  top.addColorStop(0, '#3d4844')
  top.addColorStop(1, '#323b37')
  const bottom = ctx.createLinearGradient(0, y + h / 2, 0, y + h)
  bottom.addColorStop(0, '#2b332f')
  bottom.addColorStop(1, '#242b28')
  ctx.save()
  roundRect(ctx, x, y, w, h, 18)
  ctx.clip()
  ctx.fillStyle = top
  ctx.fillRect(x, y, w, h / 2)
  ctx.fillStyle = bottom
  ctx.fillRect(x, y + h / 2, w, h / 2)
  ctx.fillStyle = '#f3ecd8'
  ctx.font = '700 196px "Segoe UI", "Inter", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(digit, x + w / 2, y + h / 2 + 8)
  // A dobra: uma faixa escura e um fio de luz logo abaixo.
  ctx.fillStyle = '#161b19'
  ctx.fillRect(x, y + h / 2 - 2, w, 4)
  ctx.fillStyle = 'rgba(255,255,255,0.06)'
  ctx.fillRect(x, y + h / 2 + 2, w, 2)
  ctx.restore()
  ctx.fillStyle = '#161b19'
  for (const cx of [x - 2, x + w + 2]) {
    ctx.beginPath()
    ctx.arc(cx, y + h / 2, 7, 0, Math.PI * 2)
    ctx.fill()
  }
}

function draw(ctx: CanvasRenderingContext2D, f: ClockFace): void {
  const bg = ctx.createRadialGradient(TEX_W / 2, TEX_H / 2, 60, TEX_W / 2, TEX_H / 2, TEX_W * 0.6)
  bg.addColorStop(0, '#2f3834')
  bg.addColorStop(1, '#232a27')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, TEX_W, TEX_H)
  // H H : M M — quatro cartões, os dois-pontos de latão no meio.
  const w = 190
  const h = 250
  const gap = 22
  const colon = 60
  const x0 = (TEX_W - (4 * w + 2 * gap + colon)) / 2
  const y = 30
  const xs = [x0, x0 + w + gap, x0 + 2 * w + gap + colon, x0 + 3 * w + 2 * gap + colon]
  const digits = [...f.hh, ...f.mm]
  xs.forEach((x, i) => card(ctx, x, y, w, h, digits[i]))
  ctx.fillStyle = '#c2a46b'
  const cx = x0 + 2 * w + gap + colon / 2
  for (const k of [0.36, 0.64]) {
    ctx.beginPath()
    ctx.arc(cx, y + h * k, 11, 0, Math.PI * 2)
    ctx.fill()
  }
  // A data à esquerda e a saudação à direita.
  const left = x0
  const right = x0 + 4 * w + 2 * gap + colon
  ctx.textBaseline = 'alphabetic'
  ctx.font = '600 42px "Segoe UI", "Inter", sans-serif'
  ctx.fillStyle = '#cfc8b3'
  ctx.textAlign = 'left'
  ctx.fillText(f.date, left, 342)
  ctx.font = 'italic 500 42px "Segoe UI", "Inter", sans-serif'
  ctx.fillStyle = '#9db38f'
  ctx.textAlign = 'right'
  ctx.fillText(f.greeting, right, 342)
  // A barra do dia: trilho, o que já passou em sálvia, risquinhos em 6h/12h/18h e o ponto de latão.
  const by = 378
  roundRect(ctx, left, by, right - left, 10, 5)
  ctx.fillStyle = '#3a4440'
  ctx.fill()
  roundRect(ctx, left, by, Math.max(10, (right - left) * f.day), 10, 5)
  ctx.fillStyle = '#8fa680'
  ctx.fill()
  ctx.fillStyle = '#5c6862'
  for (const k of [0.25, 0.5, 0.75]) ctx.fillRect(left + (right - left) * k - 1.5, by + 16, 3, 10)
  ctx.fillStyle = '#c2a46b'
  ctx.beginPath()
  ctx.arc(left + (right - left) * f.day, by + 5, 11, 0, Math.PI * 2)
  ctx.fill()
}

export interface WallClock {
  dispose(): void
}

/** Monta o relógio: a moldura vai em `statics` (fundida com a zona), a face em `zone`. */
export function buildWallClock(kit: Kit, zone: Group, statics: Group, onDirty: () => void, now: () => Date = () => new Date()): WallClock {
  const m = kit.mat
  const z = BACK_FACE_Z
  const { x, y, w, h } = CLOCK
  box(kit, statics, m.shelf, w, h, 0.035, x, y, z + 0.018, true)
  box(kit, statics, m.charcoal, w - 0.08, h - 0.08, 0.012, x, y, z + 0.041)
  tagLod(box(kit, statics, m.brass, w - 0.18, 0.014, 0.022, x, y + h / 2 + 0.007, z + 0.03), 'detail')
  const { canvas, ctx } = canvas2d(TEX_W, TEX_H)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = kit.anisotropy
  const mat = new MeshLambertMaterial({ map: texture, emissive: 0xffffff, emissiveMap: texture, emissiveIntensity: 0.28 })
  const geo = new PlaneGeometry(w - 0.1, (w - 0.1) * (TEX_H / TEX_W))
  const face = new Mesh(geo, mat)
  face.position.set(x, y, z + 0.048)
  face.name = 'wall-clock'
  zone.add(face)
  let shown = ''
  const tick = (): void => {
    const f = clockFace(now())
    if (f.key === shown) return
    shown = f.key
    if (ctx) draw(ctx, f)
    texture.needsUpdate = true
    onDirty()
  }
  tick()
  const timer = setInterval(tick, CHECK_MS)
  return {
    dispose() {
      clearInterval(timer)
      face.removeFromParent()
      geo.dispose()
      mat.dispose()
      texture.dispose()
    }
  }
}
