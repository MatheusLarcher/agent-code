/**
 * Geometrias do corpo dos agentes (compartilhadas: criadas uma vez por cena no
 * Kit e liberadas com ele). Proporções de adulto de ~1,80 m (BODY em poses.ts):
 * tronco torneado (quadril → cintura → peito → ombros), quadril, membros que
 * afinam (coxa, canela, braço, antebraço), mãos com dedos e polegar, sapato
 * com sola, pescoço e a cabeça com queixo, nariz e orelhas numa malha só.
 * Cabelos em seis cortes (HAIR_STYLES). Cada peça tem o pivô na junta de cima
 * (o membro desce em −Y) e a frente do corpo é −Z.
 */
import { BoxGeometry, BufferGeometry, CylinderGeometry, LatheGeometry, SphereGeometry, Vector2 } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { BODY } from './poses'

/** Só posição e normal (as peças fundidas precisam do mesmo conjunto). */
function bare(g: BufferGeometry): BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g
  if (out !== g) g.dispose()
  for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'normal') out.deleteAttribute(name)
  return out
}

function fuse(parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts.map(bare), false)!
  for (const p of parts) p.dispose()
  g.computeBoundingSphere()
  return g
}

/**
 * Membro afinando de `rTop` (na junta, y = 0) a `rBot` (em y = −len), com as
 * pontas arredondadas e achatado em Z por `flat` (seção oval).
 */
function limb(rTop: number, rBot: number, len: number, flat = 0.9, seg = 8): BufferGeometry {
  const pts: Vector2[] = []
  const cap = 3
  // De baixo para cima: meia esfera de baixo, o cone, meia esfera de cima.
  for (let i = 0; i <= cap; i++) {
    const a = (i / cap) * (Math.PI / 2)
    pts.push(new Vector2(rBot * Math.sin(a), -len - rBot * Math.cos(a) * 0.8))
  }
  for (let i = cap; i >= 0; i--) {
    const a = (i / cap) * (Math.PI / 2)
    pts.push(new Vector2(rTop * Math.sin(a), rTop * Math.cos(a) * 0.8))
  }
  const g = new LatheGeometry(pts, seg)
  g.scale(1, 1, flat)
  return g
}

/** Tronco: da cintura (y = 0, no quadril) até a base do pescoço; peito mais fundo que a cintura. */
function torso(): BufferGeometry {
  const S = BODY.shoulderY
  const prof: Array<[number, number]> = [
    [0, -0.02], [0.128, -0.01], [0.124, 0.07], [0.132, 0.16], [0.152, 0.27], [0.164, S - 0.12], [0.166, S - 0.05],
    [0.15, S + 0.005], [0.1, S + 0.035], [0.055, S + 0.05], [0, S + 0.055]
  ]
  const g = new LatheGeometry(prof.map(([r, y]) => new Vector2(r, y)), 12)
  g.scale(1.12, 1, 0.66)
  // O peito um pouco à frente e as costas retas.
  const p = g.attributes.position
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i)
    const z = p.getZ(i)
    if (z < 0 && y > 0.18) p.setZ(i, z * (1 + 0.12 * Math.min(1, (y - 0.18) / 0.15)))
  }
  g.computeVertexNormals()
  return g
}

/** Quadril/bacia (calça): do cinto ao começo das coxas. */
function hips(): BufferGeometry {
  const prof: Array<[number, number]> = [[0, -0.11], [0.12, -0.105], [0.165, -0.065], [0.172, -0.02], [0.152, 0.03], [0.138, 0.05], [0, 0.055]]
  const g = new LatheGeometry(prof.map(([r, y]) => new Vector2(r, y)), 12)
  g.scale(1.08, 1, 0.66)
  return g
}

/** Cabeça: elipsoide com o queixo afinando, nariz e orelhas (uma malha, a pele). */
function head(): BufferGeometry {
  const { headW, headH, headD } = BODY
  const skull = new SphereGeometry(1, 16, 12)
  const p = skull.attributes.position
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i)
    const y = p.getY(i)
    let z = p.getZ(i)
    // Queixo e mandíbula mais estreitos embaixo; a nuca um pouco mais cheia atrás.
    if (y < 0) x *= 1 - 0.22 * -y
    if (y < -0.3 && z < 0) z *= 1 - 0.1 * (-y - 0.3)
    if (z > 0 && y > -0.2) z *= 1.06
    p.setXYZ(i, x * headW, y * headH, z * headD)
  }
  skull.computeVertexNormals()
  const nose = new RoundedBoxGeometry(0.026, 0.05, 0.03, 1, 0.01)
  nose.translate(0, -0.012, -headD + 0.004)
  const ears = [-1, 1].map((s) => {
    const e = new SphereGeometry(1, 6, 4)
    e.scale(0.012, 0.03, 0.022)
    e.translate(s * headW * 0.98, -0.005, 0.008)
    return e
  })
  return fuse([skull, nose, ...ears])
}

/** Calota de cabelo em volta da cabeça: `cover` (rad, a partir do topo) e quanto ela pende para trás. */
function cap(cover: number, back: number, puff = 1.07, ySeg = 7): BufferGeometry {
  const g = new SphereGeometry(1, 16, ySeg, 0, Math.PI * 2, 0, cover)
  g.rotateX(back)
  g.scale(BODY.headW * puff, BODY.headH * puff, BODY.headD * puff)
  return g
}

/** Cabelo comprido atrás e dos lados (sem a frente), até `down` abaixo do centro da cabeça. */
function backHair(down: number, puff = 1.1): BufferGeometry {
  const g = new SphereGeometry(1, 12, 6, -0.55, Math.PI + 1.1, 0.35, Math.PI / 2 + down)
  g.scale(BODY.headW * puff, BODY.headH * 1.02, BODY.headD * puff)
  return g
}

/** Os seis cortes: curto, topete, chanel, raspado, coque e cacheado. */
export const HAIR_STYLES = ['hairShort', 'hairQuiff', 'hairBob', 'hairBuzz', 'hairBun', 'hairCurly'] as const
export type HairStyle = (typeof HAIR_STYLES)[number]

function hairStyles(): Record<HairStyle, BufferGeometry> {
  const bun = new SphereGeometry(0.05, 8, 6)
  bun.translate(0, BODY.headH * 0.55, BODY.headD * 0.95)
  const quiff = new RoundedBoxGeometry(0.13, 0.05, 0.09, 1, 0.022)
  quiff.rotateX(-0.35)
  quiff.translate(0, BODY.headH * 0.95, -BODY.headD * 0.45)
  const curls: BufferGeometry[] = [cap(1.25, 0.32, 1.16, 10)]
  // Cachos no alto e atrás (a frente, −Z, fica livre para o rosto).
  for (let i = 0; i < 7; i++) {
    const a = -0.35 + (i / 6) * (Math.PI + 0.7)
    const c = new SphereGeometry(0.042, 6, 4)
    c.translate(-Math.cos(a) * BODY.headW * 0.92, BODY.headH * (0.55 + 0.18 * (i % 2)), Math.sin(a) * BODY.headD * 0.9 + 0.012)
    curls.push(c)
  }
  return {
    hairShort: cap(1.18, 0.38),
    hairQuiff: fuse([cap(1.12, 0.42), quiff]),
    hairBob: fuse([cap(1.2, 0.3, 1.09), backHair(0.55)]),
    hairBuzz: cap(1.22, 0.4, 1.03),
    hairBun: fuse([cap(1.2, 0.34, 1.06), bun, backHair(0.05, 1.07)]),
    hairCurly: fuse(curls)
  }
}

export function createBodyGeometries() {
  const { thigh, shin, upperArm, forearm } = BODY
  const shoe = fuse([new RoundedBoxGeometry(0.105, 0.075, 0.27, 1, 0.03).translate(0, -0.045, -0.055), new BoxGeometry(0.11, 0.02, 0.275).translate(0, -0.075, -0.055)])
  return {
    torso: torso(),
    hips: hips(),
    head: head(),
    neck: new CylinderGeometry(0.042, 0.048, 0.12, 10),
    thigh: limb(0.094, 0.066, thigh, 0.95),
    shin: limb(0.058, 0.045, shin, 0.92),
    upperArm: limb(0.056, 0.044, upperArm, 0.92),
    forearm: limb(0.045, 0.034, forearm, 0.85),
    hand: new RoundedBoxGeometry(0.07, 0.08, 0.03, 1, 0.012).translate(0, -0.038, 0),
    fingers: new BoxGeometry(0.064, 0.062, 0.024).translate(0, -0.028, 0),
    thumb: new BoxGeometry(0.022, 0.05, 0.022).translate(0, -0.022, 0),
    shoe,
    ...hairStyles()
  }
}

export type BodyGeometries = ReturnType<typeof createBodyGeometries>
