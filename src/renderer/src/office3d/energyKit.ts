/**
 * Recursos COMPARTILHADOS da energia do escritório (usina, apagão e festa):
 * texturas desenhadas em canvas, geometrias e materiais criados uma vez por
 * cena e liberados juntos em `dispose()`. Nada aqui é luz de verdade: o brilho
 * vem de materiais básicos (não iluminados) e aditivos — luzes novas fariam o
 * three recompilar todos os shaders.
 *
 * Ordem de desenho (renderOrder) dos transparentes: o escurecimento da sala
 * (1) vem depois do que é da sala (0, escurece junto) e antes do que brilha no
 * escuro: luar, emergência, SAÍDA, facho da lanterna e manchas da bola (2–3).
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  IcosahedronGeometry,
  MeshBasicMaterial,
  MeshLambertMaterial,
  RepeatWrapping,
  SpriteMaterial,
  SRGBColorSpace,
  type Material,
  type Texture
} from 'three'
import { canvas2d, rng } from './textures'

export const ORDER_DIM = 1
export const ORDER_GLOW = 2
export const ORDER_SPOTS = 3

function texture(canvas: HTMLCanvasElement, repeat = false): CanvasTexture {
  const t = new CanvasTexture(canvas)
  t.colorSpace = SRGBColorSpace
  if (repeat) t.wrapS = RepeatWrapping
  return t
}

/** Brilho redondo: branco no centro, transparente na borda. */
function glowTexture(): CanvasTexture {
  const { canvas, ctx } = canvas2d(64, 64)
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
  }
  return texture(canvas)
}

/** Facho do luar: forte junto da janela (topo), some no chão e nas bordas. */
function shaftTexture(): CanvasTexture {
  const { canvas, ctx } = canvas2d(32, 64)
  if (ctx) {
    const v = ctx.createLinearGradient(0, 64, 0, 0)
    v.addColorStop(0, 'rgba(255,255,255,0)')
    v.addColorStop(1, 'rgba(255,255,255,0.9)')
    ctx.fillStyle = v
    ctx.fillRect(0, 0, 32, 64)
    ctx.globalCompositeOperation = 'destination-in'
    const h = ctx.createLinearGradient(0, 0, 32, 0)
    h.addColorStop(0, 'rgba(0,0,0,0)')
    h.addColorStop(0.2, 'rgba(0,0,0,1)')
    h.addColorStop(0.8, 'rgba(0,0,0,1)')
    h.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = h
    ctx.fillRect(0, 0, 32, 64)
  }
  return texture(canvas)
}

/** Placa verde de SAÍDA com a setinha. */
function exitTexture(): CanvasTexture {
  const { canvas, ctx } = canvas2d(256, 96)
  if (ctx) {
    ctx.fillStyle = '#0e9f4f'
    ctx.fillRect(0, 0, 256, 96)
    ctx.strokeStyle = '#eafff2'
    ctx.lineWidth = 6
    ctx.strokeRect(5, 5, 246, 86)
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 54px "Segoe UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('SAÍDA', 150, 52)
    ctx.beginPath()
    ctx.moveTo(22, 48)
    ctx.lineTo(52, 24)
    ctx.lineTo(52, 38)
    ctx.lineTo(70, 38)
    ctx.lineTo(70, 58)
    ctx.lineTo(52, 58)
    ctx.lineTo(52, 72)
    ctx.closePath()
    ctx.fill()
  }
  return texture(canvas)
}

/** Cabo: borracha escura com um pulso de energia (o material dá a cor); repete ao longo do cabo. */
function pulseTexture(): CanvasTexture {
  const { canvas, ctx } = canvas2d(64, 8)
  if (ctx) {
    ctx.fillStyle = '#20242c'
    ctx.fillRect(0, 0, 64, 8)
    const g = ctx.createLinearGradient(0, 0, 22, 0)
    g.addColorStop(0, 'rgba(255,255,255,0)')
    g.addColorStop(0.7, 'rgba(255,255,255,1)')
    g.addColorStop(1, 'rgba(255,255,255,0.2)')
    ctx.fillStyle = g
    ctx.fillRect(0, 1, 22, 6)
  }
  return texture(canvas, true)
}

/** Espelhinhos da bola de discoteca. */
function mirrorTexture(): CanvasTexture {
  const { canvas, ctx } = canvas2d(64, 32)
  if (ctx) {
    const r = rng(17)
    for (let y = 0; y < 32; y += 4) {
      for (let x = 0; x < 64; x += 4) {
        const l = r() < 0.12 ? 92 + r() * 8 : 38 + r() * 34
        ctx.fillStyle = `hsl(${200 + r() * 60} 12% ${l}%)`
        ctx.fillRect(x, y, 3.4, 3.4)
      }
    }
  }
  return texture(canvas)
}

/** Pizza vista de cima, na caixa — já falta uma fatia. */
function pizzaTexture(): CanvasTexture {
  const { canvas, ctx } = canvas2d(128, 128)
  if (ctx) {
    ctx.fillStyle = '#d9b27a'
    ctx.fillRect(0, 0, 128, 128)
    ctx.fillStyle = '#c47a2c'
    ctx.beginPath()
    ctx.moveTo(64, 64)
    ctx.arc(64, 64, 54, 0.5, Math.PI * 2 - 0.55)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#f2c14e'
    ctx.beginPath()
    ctx.moveTo(64, 64)
    ctx.arc(64, 64, 46, 0.55, Math.PI * 2 - 0.6)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#b8322a'
    for (const [x, y] of [[44, 40], [70, 34], [40, 74], [66, 86], [86, 62], [52, 58], [88, 92]]) {
      ctx.beginPath()
      ctx.arc(x, y, 6, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  return texture(canvas)
}

/** Aviãozinho de papel: dois triângulos (asas) e a quilha, ponta em -Z. */
function dartGeometry(): BufferGeometry {
  const v = new Float32Array([
    0, 0, -0.16, -0.09, 0.012, 0.08, 0, 0, 0.08,
    0, 0, -0.16, 0, 0, 0.08, 0.09, 0.012, 0.08,
    0, 0, -0.16, 0, 0, 0.08, 0, -0.035, 0.07
  ])
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(v, 3))
  g.computeVertexNormals()
  return g
}

export function createEnergyKit() {
  const tex = { glow: glowTexture(), shaft: shaftTexture(), exit: exitTexture(), pulse: pulseTexture(), mirror: mirrorTexture(), pizza: pizzaTexture() }
  const add = (color: number, map: Texture, opacity = 1): MeshBasicMaterial =>
    new MeshBasicMaterial({ color, map, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false, side: DoubleSide })
  const geo = { ball: new IcosahedronGeometry(0.22, 1), dart: dartGeometry() }
  const mat = {
    /** Modelo do escurecimento por sala (cada sala usa um clone: a opacidade é dela). */
    dimmer: new MeshBasicMaterial({ color: 0x03050d, transparent: true, opacity: 0, depthWrite: false }),
    moon: add(0x8aa6ff, tex.shaft, 0.55),
    glow: add(0xffffff, tex.glow, 0.95),
    emergency: new MeshBasicMaterial({ color: 0xffffff }),
    exit: new MeshBasicMaterial({ map: tex.exit, side: DoubleSide }),
    cable: new MeshBasicMaterial({ color: 0x5fe6ff, map: tex.pulse, side: DoubleSide }),
    junction: new MeshLambertMaterial({ color: 0x3a4152 }),
    spot: add(0xffffff, tex.glow, 0.85),
    ballGlow: new SpriteMaterial({ map: tex.glow, color: 0xfff1d6, transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false }),
    ball: new MeshBasicMaterial({ map: tex.mirror }),
    cord: new MeshLambertMaterial({ color: 0x2a2a2e }),
    pizzaBox: new MeshLambertMaterial({ color: 0xc8a06a }),
    pizzaTop: new MeshLambertMaterial({ map: tex.pizza }),
    paper: new MeshLambertMaterial({ color: 0xf6f4ee, side: DoubleSide })
  }
  return {
    tex,
    geo,
    mat,
    dispose(): void {
      for (const g of Object.values(geo) as BufferGeometry[]) g.dispose()
      for (const m of Object.values(mat) as Material[]) m.dispose()
      for (const t of Object.values(tex) as Texture[]) t.dispose()
    }
  }
}

export type EnergyKit = ReturnType<typeof createEnergyKit>
