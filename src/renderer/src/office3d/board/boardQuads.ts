/**
 * A malha dos papéis do kanban: UMA BufferGeometry com a face e todos os papéis
 * (um quad por célula da textura), para o quadro inteiro custar uma chamada de
 * desenho. Mexer num papel é reescrever os 4 vértices dele no array — nada
 * aloca. Quad 0 = face; quad 1 + i = célula i (pilhas 0..2, papéis 3..20).
 * Papel escondido = quad degenerado (área zero: nem desenha nem recebe clique).
 */
import { BufferAttribute, BufferGeometry, Color, Sphere, Vector3 } from 'three'
import { FACE_H, FACE_W, FACE_Z } from './boardLayout'
import { ATLAS, cellRect, CELLS, FACE_COLOR, FACE_PX_H, FACE_PX_W } from './boardPaint'

export const QUADS = 1 + CELLS

const scratch = new Color()

export class BoardQuads {
  readonly geo = new BufferGeometry()
  private readonly pos: Float32Array
  private readonly col: Float32Array
  private readonly posAttr: BufferAttribute
  private readonly colAttr: BufferAttribute

  constructor(bounds: Sphere) {
    const n = QUADS * 4
    this.pos = new Float32Array(n * 3)
    this.col = new Float32Array(n * 3)
    const uv = new Float32Array(n * 2)
    const normal = new Float32Array(n * 3)
    const index = new Uint16Array(QUADS * 6)
    for (let q = 0; q < QUADS; q++) {
      const r = q === 0 ? { x: 0, y: 0, w: FACE_PX_W, h: FACE_PX_H } : cellRect(q - 1)
      const u0 = r.x / ATLAS
      const u1 = (r.x + r.w) / ATLAS
      const v0 = 1 - (r.y + r.h) / ATLAS
      const v1 = 1 - r.y / ATLAS
      const uvs = [u0, v0, u1, v0, u1, v1, u0, v1]
      for (let k = 0; k < 8; k++) uv[q * 8 + k] = uvs[k]
      for (let k = 0; k < 4; k++) normal[(q * 4 + k) * 3 + 2] = 1
      const b = q * 4
      index.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6)
    }
    this.posAttr = new BufferAttribute(this.pos, 3)
    this.colAttr = new BufferAttribute(this.col, 3)
    this.geo.setAttribute('position', this.posAttr)
    this.geo.setAttribute('normal', new BufferAttribute(normal, 3))
    this.geo.setAttribute('uv', new BufferAttribute(uv, 2))
    this.geo.setAttribute('color', this.colAttr)
    this.geo.setIndex(new BufferAttribute(index, 1))
    // Esfera fixa sobre o quadro e o caminho até o cesto: nada é recalculado por quadro.
    this.geo.boundingSphere = bounds
    this.set(0, 0, 0, FACE_Z, FACE_W, FACE_H, 0)
    this.color(0, FACE_COLOR)
  }

  /** Quad `q` com centro (x, y, z), tamanho w × h e giro rz (plano da face). */
  set(q: number, x: number, y: number, z: number, w: number, h: number, rz: number): void {
    const c = Math.cos(rz)
    const s = Math.sin(rz)
    const hw = w / 2
    const hh = h / 2
    const p = this.pos
    let o = q * 12
    for (let k = 0; k < 4; k++) {
      const cx = k === 0 || k === 3 ? -hw : hw
      const cy = k < 2 ? -hh : hh
      p[o++] = x + cx * c - cy * s
      p[o++] = y + cx * s + cy * c
      p[o++] = z
    }
    this.posAttr.needsUpdate = true
  }

  /** Esconde o quad (área zero). */
  hide(q: number): void {
    this.set(q, 0, 0, FACE_Z, 0, 0, 0)
  }

  /** Cor do quad no MÉDIO (sem textura). */
  color(q: number, css: string): void {
    scratch.set(css)
    for (let k = 0; k < 4; k++) {
      const o = (q * 4 + k) * 3
      this.col[o] = scratch.r
      this.col[o + 1] = scratch.g
      this.col[o + 2] = scratch.b
    }
    this.colAttr.needsUpdate = true
  }

  /** Centro do quad (para testes e para ancorar a dica do hover). */
  center(q: number, out: Vector3): Vector3 {
    const p = this.pos
    const o = q * 12
    return out.set((p[o] + p[o + 6]) / 2, (p[o + 1] + p[o + 7]) / 2, p[o + 2])
  }

  dispose(): void {
    this.geo.dispose()
  }
}
