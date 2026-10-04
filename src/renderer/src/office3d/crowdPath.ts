/**
 * O caminho de um cérebro até o objetivo (o BrainWorld.plan do crowd) — PURO:
 * de fora da sala entra pela porta antes de tudo; o A* da grade (nav.ts) leva
 * ao ponto em pé do objetivo; quem sai pela porta termina do lado de fora.
 * Escreve em `b.path` (pares x, z) e devolve quantos pontos (sempre ≥ 1).
 */
import type { Brain } from './brainBody'
import type { RoomFurniture } from './furniture'
import type { RoomLayout } from './layout'
import type { NavGrid } from './nav'

/** A sala do cérebro: o retângulo, os móveis (a porta) e a grade. */
export interface PathNav {
  room: RoomLayout
  furniture: RoomFurniture
  grid: NavGrid
}

export function planPath(b: Brain, nav: PathNav | undefined, scratch: Float32Array): number {
  const g = b.goal
  const out = b.path
  if (!nav) {
    out[0] = g.x
    out[1] = g.z
    return 1
  }
  const { room, furniture: f } = nav
  let n = 0
  let sx = b.x
  let sz = b.z
  // De fora da sala: entra pela porta antes de qualquer coisa.
  if (b.x < room.x || b.x > room.x + room.width || b.z < room.z || b.z > room.z + room.depth) {
    out[0] = sx = f.doorIn.x
    out[1] = sz = f.doorIn.z
    n = 1
  }
  const tx = g.exit ? f.doorIn.x : g.x
  const tz = g.exit ? f.doorIn.z : g.z
  const m = nav.grid.findPath(sx, sz, tx, tz, scratch)
  const cap = (out.length >> 1) - 1
  if (m === 0) {
    out[n * 2] = tx
    out[n * 2 + 1] = tz
    n++
  } else {
    for (let i = 0; i < m && n < cap; i++, n++) {
      out[n * 2] = scratch[i * 2]
      out[n * 2 + 1] = scratch[i * 2 + 1]
    }
  }
  if (g.exit) {
    out[n * 2] = f.doorOut.x
    out[n * 2 + 1] = f.doorOut.z
    n++
  }
  return n
}
