/**
 * Texturas procedurais desenhadas em canvas 2D (nada baixado): piso de madeira,
 * tapete, céu das janelas conforme a hora, protetor de tela e o "z"
 * de quem cochila. Sem contexto 2D (jsdom) a textura fica em branco — nada quebra.
 */
import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three'

export function canvas2d(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D | null } {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = canvas.getContext('2d')
  } catch {
    ctx = null
  }
  return { canvas, ctx }
}

/** Gerador pseudoaleatório determinístico (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function make(canvas: HTMLCanvasElement, repeat: boolean): CanvasTexture {
  const t = new CanvasTexture(canvas)
  t.colorSpace = SRGBColorSpace
  if (repeat) t.wrapS = t.wrapT = RepeatWrapping
  return t
}

/** Tábuas de madeira (1 repetição ≈ 2 m × 2 m). */
export function createWoodTexture(anisotropy = 1): CanvasTexture {
  const S = 512
  const { canvas, ctx } = canvas2d(S, S)
  if (ctx) {
    const r = rng(7)
    const plank = S / 6
    for (let i = 0; i < 6; i++) {
      const offset = r() * S
      for (const y0 of [-offset, S - offset]) {
        const l = 34 + r() * 10
        ctx.fillStyle = `hsl(${26 + r() * 8} 42% ${l}%)`
        ctx.fillRect(i * plank, y0, plank, S)
      }
      // Veios.
      for (let k = 0; k < 14; k++) {
        ctx.strokeStyle = `rgba(60,30,10,${0.06 + r() * 0.1})`
        ctx.lineWidth = 1 + r() * 2
        const x = i * plank + r() * plank
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.bezierCurveTo(x + (r() - 0.5) * 12, S / 3, x + (r() - 0.5) * 12, (2 * S) / 3, x, S)
        ctx.stroke()
      }
      ctx.fillStyle = 'rgba(25,12,4,0.55)'
      ctx.fillRect(i * plank, 0, 2, S)
      ctx.fillRect(i * plank, S - offset, plank, 2)
    }
  }
  const t = make(canvas, true)
  t.anisotropy = anisotropy
  return t
}

/** Tapete felpudo com borda. */
export function createRugTexture(): CanvasTexture {
  const W = 512
  const H = 256
  const { canvas, ctx } = canvas2d(W, H)
  if (ctx) {
    const r = rng(11)
    ctx.fillStyle = '#7a3b2e'
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = '#c99a5b'
    ctx.fillRect(18, 18, W - 36, H - 36)
    ctx.fillStyle = '#8f4636'
    ctx.fillRect(30, 30, W - 60, H - 60)
    ctx.strokeStyle = '#e3c68f'
    ctx.lineWidth = 4
    for (let i = 0; i < 7; i++) {
      const x = 70 + i * ((W - 140) / 6)
      ctx.beginPath()
      ctx.moveTo(x, H / 2 - 50)
      ctx.lineTo(x + 26, H / 2)
      ctx.lineTo(x, H / 2 + 50)
      ctx.lineTo(x - 26, H / 2)
      ctx.closePath()
      ctx.stroke()
    }
    for (let i = 0; i < 4000; i++) {
      ctx.fillStyle = `rgba(${r() > 0.5 ? '255,255,255' : '0,0,0'},${r() * 0.06})`
      ctx.fillRect(r() * W, r() * H, 2, 2)
    }
  }
  return make(canvas, false)
}

export interface SkyPalette {
  top: string
  bottom: string
  sun: string | null
  stars: boolean
}

/** Céu pela hora local (0..23): noite, amanhecer, dia, entardecer. */
export function skyPalette(hour: number): SkyPalette {
  const h = ((Math.floor(hour) % 24) + 24) % 24
  if (h >= 20 || h < 5) return { top: '#0b1430', bottom: '#1d2b55', sun: null, stars: true }
  if (h < 7) return { top: '#4a5f9e', bottom: '#f3a77a', sun: '#ffd9a0', stars: false }
  if (h < 17) return { top: '#4f9be0', bottom: '#bfe3ff', sun: '#fff6d8', stars: false }
  return { top: '#3b4f8f', bottom: '#f58b5a', sun: '#ffc27a', stars: false }
}

/** Uma textura de céu compartilhada por todas as janelas; `draw(hour)` só redesenha quando a faixa muda. */
export function createSkyTexture(): { texture: CanvasTexture; draw(hour: number): boolean } {
  const W = 256
  const H = 256
  const { canvas, ctx } = canvas2d(W, H)
  const texture = make(canvas, false)
  let last = ''
  return {
    texture,
    draw(hour) {
      const p = skyPalette(hour)
      const sig = `${p.top}${p.bottom}`
      if (sig === last) return false
      last = sig
      if (!ctx) return true
      const g = ctx.createLinearGradient(0, 0, 0, H)
      g.addColorStop(0, p.top)
      g.addColorStop(1, p.bottom)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, W, H)
      const r = rng(3)
      if (p.stars) {
        for (let i = 0; i < 60; i++) {
          ctx.fillStyle = `rgba(255,255,255,${0.3 + r() * 0.7})`
          ctx.fillRect(r() * W, r() * H * 0.7, 1.5, 1.5)
        }
        ctx.fillStyle = '#f4f1dc'
        ctx.beginPath()
        ctx.arc(W * 0.72, H * 0.25, 16, 0, Math.PI * 2)
        ctx.fill()
      } else if (p.sun) {
        ctx.fillStyle = p.sun
        ctx.beginPath()
        ctx.arc(W * 0.3, H * 0.62, 22, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = 'rgba(255,255,255,0.75)'
        for (let i = 0; i < 4; i++) {
          const x = r() * W
          const y = 30 + r() * H * 0.4
          ctx.beginPath()
          ctx.ellipse(x, y, 28 + r() * 20, 9 + r() * 4, 0, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      // Silhueta de prédios ao longe.
      ctx.fillStyle = p.stars ? '#0a0f22' : 'rgba(40,52,80,0.55)'
      for (let x = 0; x < W; ) {
        const w = 18 + r() * 26
        const h = 30 + r() * 70
        ctx.fillRect(x, H - h, w - 3, h)
        x += w
      }
      texture.needsUpdate = true
      return true
    }
  }
}

/** Protetor de tela discreto e estático, um só para todos os monitores ociosos. */
export function createScreensaverTexture(): CanvasTexture {
  const W = 256
  const H = 144
  const { canvas, ctx } = canvas2d(W, H)
  if (ctx) {
    ctx.fillStyle = '#05070b'
    ctx.fillRect(0, 0, W, H)
    const r = rng(9)
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(150,180,255,${0.08 + r() * 0.25})`
      ctx.fillRect(r() * W, r() * H, 1.5, 1.5)
    }
    ctx.strokeStyle = 'rgba(120,160,255,0.22)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(W * 0.62, H * 0.55, 20, 0, Math.PI * 2)
    ctx.stroke()
  }
  return make(canvas, false)
}

/** "z" do cochilo (sprite). */
export function createZTexture(): CanvasTexture {
  const S = 64
  const { canvas, ctx } = canvas2d(S, S)
  if (ctx) {
    ctx.font = 'bold 50px "Segoe UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = 6
    ctx.strokeStyle = 'rgba(20,24,40,0.8)'
    ctx.strokeText('z', S / 2, S / 2)
    ctx.fillStyle = '#e8eeff'
    ctx.fillText('z', S / 2, S / 2)
  }
  return make(canvas, false)
}
