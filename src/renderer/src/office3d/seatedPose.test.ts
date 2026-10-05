import { describe, expect, it } from 'vitest'
import { Box3, BufferGeometry, Group, InstancedMesh, Mesh, Vector3 } from 'three'
import { BACK_TILT, CHAIR_CENTER_Z, SEAT_TOP } from './chairModel'
import { actionPose, reactionPose } from './gestures'
import { createKit } from './kit'
import { DESK_D, DESK_HEIGHT, KEYBOARD_FRONT, MONITOR_BACK, MONITOR_Y, SEAT_FRONT, STATION_DZ } from './officePlan'
import { DESK_PLAQUE_X, DESK_PLAQUE_Z } from './plaques'
import { lerpPose, newPose, REACTION_S, sitLower, standPose, UPPER, type Action, type Reaction } from './poses'
import { applyPose, buildRig } from './rig'

/**
 * A pose sentada da estação não atravessa nada: o boneco na origem olhando
 * para −Z (a mesa "de frente"; a de fundo é a mesma mesa girada π), a mobília no
 * referencial dele. Cada parte do corpo (caixas, tronco, cabeça) tem os vértices
 * e pontos ao longo das arestas testados contra o tampo, o monitor, a
 * divisória, o teclado, o assento, o encosto e os braços da cadeira do mockup
 * (chairModel.ts), em vários instantes de cada ação (e com as reações curtas por
 * cima). O estofado do assento afunda até SEAT_GIVE sob as coxas.
 */
const SEAT_GIVE = 0.035
/** O encosto (BACK_TILT, o do mockup: o alto vem para a frente): a face da frente na altura y, no referencial de quem senta. */
const backFront = (y: number): number => CHAIR_CENTER_Z + 0.28 + (y - 0.88) * Math.tan(BACK_TILT) - 0.045
/** Uma faixa do encosto entre y0 e y1 (começa na frente mais adiantada dela). */
const backBand = (y0: number, y1: number): Box3 => box(-0.31, 0.31, y0, y1, Math.min(backFront(y0), backFront(y1)), Math.max(backFront(y0), backFront(y1)) + 0.09)
const EPS = 0.008
const edge = SEAT_FRONT - DESK_D / 2
const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Box3 =>
  new Box3(new Vector3(x0 + EPS, y0 + EPS, z0 + EPS), new Vector3(x1 - EPS, y1 - EPS, z1 - EPS))
const FURNITURE: Record<string, Box3> = {
  tampo: box(-0.775, 0.775, DESK_HEIGHT - 0.025, DESK_HEIGHT + 0.025, -(SEAT_FRONT + DESK_D / 2), -edge),
  monitor: box(-0.47, 0.47, MONITOR_Y - 0.28, MONITOR_Y + 0.28, -(SEAT_FRONT + MONITOR_BACK) - 0.02, -(SEAT_FRONT + MONITOR_BACK) + 0.02),
  divisoria: box(-2, 2, DESK_HEIGHT + 0.025, DESK_HEIGHT + 0.445, -(SEAT_FRONT + STATION_DZ) - 0.025, -(SEAT_FRONT + STATION_DZ) + 0.025),
  teclado: box(-0.23, 0.23, DESK_HEIGHT + 0.025, DESK_HEIGHT + 0.047, -(SEAT_FRONT - KEYBOARD_FRONT) - 0.075, -(SEAT_FRONT - KEYBOARD_FRONT) + 0.075),
  assento: box(-0.32, 0.32, SEAT_TOP - 0.14, SEAT_TOP - SEAT_GIVE, CHAIR_CENTER_Z - 0.31, CHAIR_CENTER_Z + 0.31),
  encosto1: backBand(0.58, 0.73),
  encosto2: backBand(0.73, 0.88),
  encosto3: backBand(0.88, 1.03),
  encosto4: backBand(1.03, 1.18),
  bracoE: box(-0.385, -0.295, 0.775, 0.815, CHAIR_CENTER_Z - 0.23, CHAIR_CENTER_Z + 0.15),
  bracoD: box(0.295, 0.385, 0.775, 0.815, CHAIR_CENTER_Z - 0.23, CHAIR_CENTER_Z + 0.15),
  plaquinhaE: box(-DESK_PLAQUE_X - 0.06, -DESK_PLAQUE_X + 0.06, DESK_HEIGHT + 0.025, DESK_HEIGHT + 0.145, -(SEAT_FRONT - DESK_PLAQUE_Z) - 0.009, -(SEAT_FRONT - DESK_PLAQUE_Z) + 0.009),
  plaquinhaD: box(DESK_PLAQUE_X - 0.06, DESK_PLAQUE_X + 0.06, DESK_HEIGHT + 0.025, DESK_HEIGHT + 0.145, -(SEAT_FRONT - DESK_PLAQUE_Z) - 0.009, -(SEAT_FRONT - DESK_PLAQUE_Z) + 0.009)
}

const SEATED: readonly Action[] = ['type', 'typeFast', 'readScreen', 'sitIdle', 'drum', 'sip', 'napDesk']
const REACTIONS: readonly Reaction[] = ['alert', 'scared', 'knuckles', 'celebrate', 'stretch', 'facepalm', 'fistpump', 'handsHead', 'yawn', 'watch', 'handoff', 'greet', 'thumbsUp', 'shrug']

/** Vértices da geometria e pontos a cada ~1,5 cm ao longo das arestas dos triângulos. */
function samples(geo: BufferGeometry): Vector3[] {
  const pos = geo.attributes.position
  const idx = geo.index
  const at = (i: number): Vector3 => new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i))
  const out: Vector3[] = []
  const n = idx ? idx.count : pos.count
  for (let t = 0; t + 2 < n; t += 3) {
    const tri = [0, 1, 2].map((k) => at(idx ? idx.getX(t + k) : t + k))
    for (let k = 0; k < 3; k++) {
      const a = tri[k]
      const b = tri[(k + 1) % 3]
      for (let s = 0; s <= 6; s++) out.push(a.clone().lerp(b, s / 6))
    }
  }
  return out
}

/** Pontos do corpo que caem dentro da mobília (com as reações por cima, se pedido). */
function clipping(reactionsToo: boolean): string[] {
  const kit = createKit(1)
  const root = new Group()
  const rig = buildRig(kit, root, { skin: kit.mat.eye, shirt: kit.mat.eye, hair: kit.mat.eye, pants: kit.mat.eye })
  const parts: Array<{ mesh: Mesh; pts: Vector3[] }> = []
  root.traverse((o) => {
    // O rosto (instanciado, minúsculo, na frente da cabeça) não entra: a geometria dele é a caixa unitária.
    if (o instanceof Mesh && !(o instanceof InstancedMesh)) parts.push({ mesh: o, pts: samples(o.geometry) })
  })
  const hits = new Set<string>()
  const p = new Vector3()
  const params = { speed: 1, seed: 1.3, side: 1, seated: true }
  for (const action of SEATED) {
    for (let t = 0; t < 4; t += 0.13) {
      const lower = newPose()
      // Cada agente senta do seu jeito (vary pela seed): as duas pontas e o meio.
      sitLower(lower, 'chair', t, 1, (Math.floor(t * 7) % 3) / 2)
      const upper = newPose()
      standPose(upper)
      actionPose(upper, action, t, params)
      const out = newPose()
      out.set(lower)
      lerpPose(out, lower, upper, 1, UPPER)
      let label: string = action
      if (reactionsToo) {
        const r = REACTIONS[Math.floor(t * 3) % REACTIONS.length]
        reactionPose(out, r, (t * 0.7) % REACTION_S[r], params, true)
        label = `${action}+${r}`
      }
      applyPose(rig, out, 1, 0)
      root.updateMatrixWorld(true)
      for (const { mesh, pts } of parts) {
        for (const v of pts) {
          p.copy(v).applyMatrix4(mesh.matrixWorld)
          for (const [name, b] of Object.entries(FURNITURE)) if (b.containsPoint(p)) hits.add(`${label}: ${mesh.geometry.type}@${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} → ${name}`)
        }
      }
    }
  }
  kit.dispose()
  return [...hits].slice(0, 12)
}

describe('pose sentada da estação', { timeout: 120_000 }, () => {
  it('em type, typeFast, readScreen, sitIdle, drum, sip e no cochilo nenhuma parte do boneco atravessa tampo, monitor, divisória, teclado, assento ou encosto', () => {
    expect(clipping(false)).toEqual([])
  })

  it('as reações curtas feitas sentado (susto, comemorar, facepalm, relógio, pasta, tchau…) também não atravessam a mesa nem deitam no encosto', () => {
    expect(clipping(true)).toEqual([])
  })

  it('a pose: quadril sobre o assento, joelhos sob o tampo, pés no chão dentro da base de rodinhas, costas junto do encosto', () => {
    const kit = createKit(1)
    const root = new Group()
    const rig = buildRig(kit, root, { skin: kit.mat.eye, shirt: kit.mat.eye, hair: kit.mat.eye, pants: kit.mat.eye })
    const pose = newPose()
    sitLower(pose, 'chair')
    applyPose(rig, pose, 1, 0)
    root.updateMatrixWorld(true)
    const v = new Vector3()
    const pelvis = new Box3().setFromObject(rig.pelvis.children[0], true)
    expect(pelvis.min.y).toBeGreaterThanOrEqual(SEAT_TOP - 0.005)
    expect(pelvis.min.y).toBeLessThan(SEAT_TOP + 0.04)
    rig.kneeR.getWorldPosition(v)
    expect(v.z).toBeLessThan(-edge)
    // O joelho (a junta e a carne em volta) cabe sob o tampo.
    expect(v.y + 0.07).toBeLessThan(DESK_HEIGHT - 0.025)
    // A ponta do pé no chão (o calcanhar erguido), perto da base de rodízios (um pé pode ir um pouco à frente).
    const shoe = new Box3().setFromObject(rig.footR.children[0], true)
    expect(Math.abs(shoe.min.y)).toBeLessThan(0.02)
    rig.footR.getWorldPosition(v)
    expect(Math.hypot(v.x, v.z - CHAIR_CENTER_Z)).toBeLessThan(0.55)
    const torso = new Box3().setFromObject(rig.torso, true)
    expect(torso.max.z).toBeGreaterThan(backFront(1.1) - 0.06)
    kit.dispose()
  })
})
