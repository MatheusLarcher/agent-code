/**
 * Papéis de memória na mesa: uma folha por memória DISTINTA que o dono leu
 * (deskMemoryReads, memoryUsage.ts), empilhadas à direita do teclado — do outro
 * lado da pilha de contexto (paperPile.ts) —, entre o fichário/caneca, o mouse e
 * a plaquinha da mesa, com teto visual de MAX_SHEETS.
 *
 * Uma InstancedMesh por ilha, refeita só quando a contagem de alguma mesa muda
 * (nada por quadro), marcada 'small' como a pilha de contexto. O clique: uma
 * caixa invisível por mesa com a chave `${MEMORY_PAPERS_KEY}${dono}`, fora do
 * raio (camadas desligadas) enquanto a mesa não tem folha.
 */
import { Color, InstancedMesh, Mesh, MeshBasicMaterial, Object3D, type Group } from 'three'
import type { OfficeFeed } from '../office/adapter/feed'
import type { Conversation } from '../types'
import type { RoomView } from './decor'
import { MEMORY_PAPERS_KEY } from './engineTypes'
import type { Kit } from './kit'
import { DESK_HEIGHT, type DeskLayout, type Office3DLayout, type RoomLayout } from './layout'
import { deskMemoryReads } from './memoryUsage'
import { deskPoint } from './officePlan'
import { tagLod } from './roomLod'

/** Teto visual da pilha (a lista mostra todas). */
export const MAX_SHEETS = 12
/** Centro da pilha no referencial da mesa: à direita de quem senta, entre o fichário (z ≤ 0,06) e a plaquinha (z 0,42). */
export const MEMORY_PAPERS_AT = { lx: 0.56, lz: 0.2 } as const
/** Folha: largura, espessura e profundidade (m); o passo da pilha. */
const SHEET = { w: 0.17, h: 0.004, d: 0.22 } as const
const STEP = 0.0045
/** O tampo da mesa (a caixa dele tem 5 cm, centrada em DESK_HEIGHT). */
const TOP = DESK_HEIGHT + 0.026
const TINT = [new Color(0xfbf8f0), new Color(0xf1ecdf), new Color(0xfdf6d8), new Color(0xf6f3ec)]
const TWIST = [0.04, -0.07, 0.1, -0.03, 0.06, -0.1]
const SHIFT = [0, 0.006, -0.005, 0.008, -0.007, 0.003]
/** O alvo do clique: a pilha cheia e uma folga em volta. */
const PICK = { w: 0.24, h: 0.09, d: 0.29 } as const
/** Invisível (o renderer não desenha, nada vai à GPU): um só para todas as mesas. */
const PICK_MAT = new MeshBasicMaterial({ visible: false })

export interface MemoryPapers {
  readonly mesh: InstancedMesh
  /** Os alvos de clique, um por mesa (índice local). */
  readonly picks: readonly Mesh[]
  /** Folhas da mesa `desk` (as memórias lidas; acima de MAX_SHEETS não cresce) e o dono (a chave do clique); só refaz quando muda. */
  set(desk: number, sheets: number, ownerKey: string | null): void
  sheets(desk: number): number
}

const dummy = new Object3D()

/** A pilha de cada mesa de `room.desks` (na ordem do índice local), dentro do grupo da zona. */
export function createMemoryPapers(kit: Kit, room: { desks: ReadonlyArray<Pick<DeskLayout, 'x' | 'z'> & { yaw?: number }> }, parent: Group): MemoryPapers {
  const desks = room.desks.length
  const counts = new Array<number>(desks).fill(0)
  const mesh = tagLod(new InstancedMesh(kit.geo.box, kit.mat.note, Math.max(1, desks * MAX_SHEETS)), 'small')
  mesh.castShadow = false
  mesh.receiveShadow = true
  mesh.name = 'memory-papers'
  parent.add(mesh)

  /** Escreve as folhas (as `n` primeiras instâncias): `full` = todas as mesas com a pilha cheia. */
  const write = (full: boolean): number => {
    let n = 0
    for (let i = 0; i < desks; i++) {
      const desk = room.desks[i]
      const yaw = desk.yaw ?? 0
      for (let k = 0; k < (full ? MAX_SHEETS : counts[i]); k++) {
        const s = SHIFT[k % SHIFT.length]
        const p = deskPoint({ x: desk.x, z: desk.z, yaw }, MEMORY_PAPERS_AT.lx + s, MEMORY_PAPERS_AT.lz - s)
        dummy.position.set(p.x, TOP + SHEET.h / 2 + k * STEP, p.z)
        dummy.rotation.set(0, yaw + TWIST[k % TWIST.length], 0)
        dummy.scale.set(SHEET.w, SHEET.h, SHEET.d)
        dummy.updateMatrix()
        mesh.setMatrixAt(n, dummy.matrix)
        mesh.setColorAt(n, TINT[k % TINT.length])
        n++
      }
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    return n
  }
  // Esfera sobre TODAS as folhas possíveis (como paperPile.ts): pilha menor só a deixa folgada.
  write(true)
  mesh.computeBoundingSphere()
  mesh.count = 0

  const picks = room.desks.map((desk) => {
    const yaw = desk.yaw ?? 0
    const p = deskPoint({ x: desk.x, z: desk.z, yaw }, MEMORY_PAPERS_AT.lx, MEMORY_PAPERS_AT.lz)
    // 'small' como as folhas: de LONGE some junto com elas e o pick (scene.ts) o ignora.
    const m = tagLod(new Mesh(kit.geo.box, PICK_MAT), 'small')
    m.name = 'memory-papers-pick'
    m.scale.set(PICK.w, PICK.h, PICK.d)
    m.position.set(p.x, TOP + PICK.h / 2, p.z)
    m.rotation.y = yaw
    m.userData.charKey = null
    m.layers.disableAll()
    parent.add(m)
    return m
  })

  return {
    mesh,
    picks,
    set(desk, sheets, ownerKey) {
      if (desk < 0 || desk >= desks) return
      const s = ownerKey ? Math.max(0, Math.min(MAX_SHEETS, Math.floor(sheets))) : 0
      // Mesa sem folha: o alvo sai do raio (o clique passa para o agente, a tela, o quadro…).
      const key = s > 0 ? `${MEMORY_PAPERS_KEY}${ownerKey}` : null
      const pick = picks[desk]
      if (pick.userData.charKey !== key) {
        pick.userData.charKey = key
        if (key) pick.layers.enable(0)
        else pick.layers.disableAll()
      }
      if (counts[desk] === s) return
      counts[desk] = s
      mesh.count = write(false)
    },
    sheets: (desk) => counts[desk] ?? 0
  }
}

/** No feed: as folhas de cada mesa = as memórias que o dono dela leu (mesa sem dono, nenhuma). */
export function syncMemoryPapers(view: Pick<RoomView, 'memos'>, r: RoomLayout, layout: Office3DLayout, feed: OfficeFeed | null, memoriesDir: string | null): void {
  const byKey = new Map(layout.characters.map((c) => [c.key, c.model]))
  r.desks.forEach((desk, i) => {
    const owner = desk.ownerKey ? byKey.get(desk.ownerKey) : undefined
    view.memos.set(i, memoryReadsOf(feed, owner?.convId, memoriesDir).length, owner?.key ?? null)
  })
}

/** As leituras de cada conversa, guardadas pelo array de mensagens (o App troca o array quando a conversa muda). */
const readsCache = new WeakMap<readonly unknown[], { dir: string; reads: string[] }>()

/** As memórias que a conversa `convId` leu (deskMemoryReads), sem refazer a varredura enquanto ela não muda. */
export function memoryReadsOf(feed: OfficeFeed | null, convId: string | null | undefined, memoriesDir: string | null): string[] {
  if (!feed || !convId || !memoriesDir) return []
  const c: Conversation | undefined = feed.conversations.find((x) => x.id === convId)
  if (!c) return []
  const hit = readsCache.get(c.messages)
  if (hit && hit.dir === memoriesDir) return hit.reads
  const reads = deskMemoryReads(c, memoriesDir)
  readsCache.set(c.messages, { dir: memoriesDir, reads })
  return reads
}
