/**
 * Pilha de papéis na mesa: o contexto USADO de cada agente, em degraus
 * (PAPER_STEPS: 50/80/90/95% → 1 a 4 resmas), como no escritório 2D. A
 * bateria acima da cabeça saiu — a bateria agora é do escritório inteiro.
 *
 * Uma InstancedMesh por sala (uma chamada de desenho), refeita só quando o
 * degrau de alguma mesa muda — nada por quadro. Marcada 'small': some no LONGE
 * junto com a decoração pequena (roomLod.ts).
 */
import { Color, InstancedMesh, Object3D, type Group } from 'three'
import type { Kit } from './kit'
import { DESK_HEIGHT, type RoomLayout } from './layout'
import { tagLod } from './roomLod'

/** Fração do contexto usada que sobe a pilha um degrau. */
export const PAPER_STEPS: readonly number[] = [0.5, 0.8, 0.9, 0.95]
export const MAX_REAMS = PAPER_STEPS.length

/** Degrau da pilha (0 = mesa limpa … 4 = quase estourando) pelo contexto da conversa. */
export function paperStep(context: { tokens: number; max: number } | undefined): number {
  if (!context || !(context.max > 0) || !(context.tokens >= 0)) return 0
  const used = context.tokens / context.max
  let n = 0
  for (const s of PAPER_STEPS) if (used >= s) n++
  return n
}

export interface PaperPiles {
  readonly mesh: InstancedMesh
  /** Degrau da mesa `desk` (0..MAX_REAMS); só refaz a pilha quando muda. */
  set(desk: number, step: number): void
  step(desk: number): number
}

const dummy = new Object3D()
/** Resma: largura, altura e profundidade (m); folhas claras alternadas, a do topo da 4ª em rosa ("URGENTE"). */
const REAM = { w: 0.24, h: 0.045, d: 0.31 } as const
const SHEET = [new Color(0xf4f1e8), new Color(0xe4dece), new Color(0xf7f3ea), new Color(0xffd6cc)]
const TWIST = [0.05, -0.09, 0.12, -0.05]
const SHIFT = [0, 0.012, -0.01, 0.016]

/** No canto esquerdo de cada mesa, dentro do grupo da sala (antes do LOD da sala ser montado). */
export function createPaperPiles(kit: Kit, room: RoomLayout, parent: Group): PaperPiles {
  const desks = room.desks.length
  const steps = new Array<number>(desks).fill(0)
  const mesh = tagLod(new InstancedMesh(kit.geo.box, kit.mat.note, Math.max(1, desks * MAX_REAMS)), 'small')
  mesh.castShadow = false
  mesh.receiveShadow = true
  mesh.name = 'paper-piles'
  parent.add(mesh)

  /** Escreve as resmas (as `n` primeiras instâncias): `full` = todas as mesas com a pilha cheia. */
  const write = (full: boolean): number => {
    let n = 0
    for (let i = 0; i < desks; i++) {
      const desk = room.desks[i]
      for (let k = 0; k < (full ? MAX_REAMS : steps[i]); k++) {
        dummy.position.set(desk.x - 0.6 + SHIFT[k], DESK_HEIGHT + 0.03 + REAM.h / 2 + k * (REAM.h + 0.002), desk.z + 0.04 - SHIFT[k])
        dummy.rotation.set(0, TWIST[k], 0)
        dummy.scale.set(REAM.w, REAM.h, REAM.d)
        dummy.updateMatrix()
        mesh.setMatrixAt(n, dummy.matrix)
        mesh.setColorAt(n, SHEET[k])
        n++
      }
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    return n
  }
  // Esfera sobre TODAS as resmas possíveis (como as cadeiras em decor.ts): pilha menor só a deixa folgada.
  write(true)
  mesh.computeBoundingSphere()
  mesh.count = 0
  const rebuild = (): void => {
    mesh.count = write(false)
  }

  return {
    mesh,
    set(desk, step) {
      const s = Math.max(0, Math.min(MAX_REAMS, Math.round(step)))
      if (desk < 0 || desk >= desks || steps[desk] === s) return
      steps[desk] = s
      rebuild()
    },
    step: (desk) => steps[desk] ?? 0
  }
}
