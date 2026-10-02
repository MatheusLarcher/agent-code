/**
 * Recursos COMPARTILHADOS dos projetores (um jogo por cena, liberado junto em
 * `dispose`): medidas da tela retrátil e do projetor de teto (em coordenadas da
 * sala: origem no meio da parede do fundo, (cx, 0, z)), a geometria do facho
 * de luz e os materiais. Nada aqui é luz de verdade: o facho é uma malha
 * aditiva (sem depthWrite) e a lente brilha com um sprite — luz nova faria o
 * three recompilar os shaders.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  MeshBasicMaterial,
  MeshLambertMaterial,
  SpriteMaterial,
  SRGBColorSpace,
  type Material
} from 'three'
import { PROJ_Z, SCREEN_W, SCREEN_Z } from './furniture'
import { canvas2d, rng } from './textures'

export { PROJ_Z, SCREEN_Z } from './furniture'

/** Tela: a frente fica SCREEN_Z na frente da parede do fundo (furniture.ts); o rolo no alto, em TOP_Y. */
export const TOP_Y = 1.88
export const CLOTH_W = SCREEN_W
export const CLOTH_H = 1.76
/** A imagem projetada (16:9) dentro do pano, centrada na tela descida. */
export const IMG_W = 2.8
export const IMG_H = 1.575
export const IMG_Y = TOP_Y - CLOTH_H / 2
/** Projetor pendurado no teto (PROJ_Z, furniture.ts), no corredor entre as mesas do meio, acima da linha da tela vista de frente. */
export const PROJ_Y = 2.45
export const CEILING_Y = 2.8
/** Centro da lente (o bico do facho). */
export const LENS = { x: 0.07, y: PROJ_Y, z: PROJ_Z - 0.16 } as const

/** Opacidade do facho aceso (aditivo). */
export const BEAM_OPACITY = 0.42

function canvasTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const t = new CanvasTexture(canvas)
  t.colorSpace = SRGBColorSpace
  return t
}

/** Facho: forte junto da lente (v = 1) e fraco na tela (v = 0), bordas suaves e um pouco de poeira. */
function beamTexture(): CanvasTexture {
  const { canvas, ctx } = canvas2d(64, 128)
  if (ctx) {
    const v = ctx.createLinearGradient(0, 0, 0, 128)
    v.addColorStop(0, 'rgba(255,255,255,0.95)')
    v.addColorStop(0.35, 'rgba(255,255,255,0.45)')
    v.addColorStop(1, 'rgba(255,255,255,0.12)')
    ctx.fillStyle = v
    ctx.fillRect(0, 0, 64, 128)
    const r = rng(41)
    for (let i = 0; i < 70; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.12 + r() * 0.25})`
      ctx.fillRect(r() * 64, r() * 128, 1, 1)
    }
    ctx.globalCompositeOperation = 'destination-in'
    const h = ctx.createLinearGradient(0, 0, 64, 0)
    h.addColorStop(0, 'rgba(0,0,0,0)')
    h.addColorStop(0.25, 'rgba(0,0,0,1)')
    h.addColorStop(0.75, 'rgba(0,0,0,1)')
    h.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = h
    ctx.fillRect(0, 0, 64, 128)
  }
  return canvasTexture(canvas)
}

/** Brilho redondo da lente. */
function glowTexture(): CanvasTexture {
  const { canvas, ctx } = canvas2d(64, 64)
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.3, 'rgba(220,235,255,0.6)')
    g.addColorStop(1, 'rgba(220,235,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
  }
  return canvasTexture(canvas)
}

/**
 * O facho: tronco de pirâmide da lente (um retangulinho) até a imagem na tela,
 * quatro faces com u ao longo da borda e v da tela (0) à lente (1).
 */
export function beamGeometry(): BufferGeometry {
  const lw = 0.035
  const lh = 0.022
  const sz = SCREEN_Z + 0.004
  const L = [
    [LENS.x - lw, LENS.y + lh, LENS.z],
    [LENS.x + lw, LENS.y + lh, LENS.z],
    [LENS.x + lw, LENS.y - lh, LENS.z],
    [LENS.x - lw, LENS.y - lh, LENS.z]
  ]
  const S = [
    [-IMG_W / 2, IMG_Y + IMG_H / 2, sz],
    [IMG_W / 2, IMG_Y + IMG_H / 2, sz],
    [IMG_W / 2, IMG_Y - IMG_H / 2, sz],
    [-IMG_W / 2, IMG_Y - IMG_H / 2, sz]
  ]
  const pos: number[] = []
  const uv: number[] = []
  const index: number[] = []
  for (let f = 0; f < 4; f++) {
    const a = f
    const b = (f + 1) % 4
    const base = pos.length / 3
    pos.push(...L[a], ...L[b], ...S[b], ...S[a])
    uv.push(0, 1, 1, 1, 1, 0, 0, 0)
    index.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2))
  g.setIndex(index)
  g.computeBoundingSphere()
  return g
}

export function createProjectorKit() {
  const tex = { beam: beamTexture(), glow: glowTexture() }
  const geo = { beam: beamGeometry() }
  const lambert = (color: number): MeshLambertMaterial => new MeshLambertMaterial({ color })
  const mat = {
    cloth: lambert(0xf3f1eb),
    border: lambert(0x1c1d21),
    housing: lambert(0x2b2e36),
    bracket: lambert(0x55575c),
    body: lambert(0xd9dbdf),
    lens: new MeshBasicMaterial({ color: 0x0c1016 }),
    ledOn: new MeshBasicMaterial({ color: 0x34c759 }),
    ledOff: lambert(0x3a3d45),
    beam: new MeshBasicMaterial({ color: 0xdfeaff, map: tex.beam, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }),
    glow: new SpriteMaterial({ map: tex.glow, color: 0xe8f1ff, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false })
  }
  return {
    tex,
    geo,
    mat,
    dispose(): void {
      geo.beam.dispose()
      for (const m of Object.values(mat) as Material[]) m.dispose()
      tex.beam.dispose()
      tex.glow.dispose()
    }
  }
}

export type ProjectorKit = ReturnType<typeof createProjectorKit>
