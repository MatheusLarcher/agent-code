/**
 * O pulso de despacho da Central (dec-layout-praca): quando uma entrada da
 * Central passa a 'delivered', um pulso claro corre pela trilha do chão, do
 * console até o destino, e o agente da Central faz o gesto de enviar.
 *
 *   conversation      até a mesa do principal da conversa (pela trilha da ilha dele);
 *   new-conversation  até a ilha reservada do projeto (ou a porta, sem ilha);
 *   new-sandbox       até a porta.
 *
 * PURO na parte de decidir (deliveredOf, PulseTracker, pulseTarget, pulsePath);
 * `CentralPulses` só move discos de um pool fixo (sem luz nova, sem alocar por
 * quadro). Com a praça fora da tela o pulso termina na hora. Entradas de outro
 * PC (`device` diferente) também pulsam. O 1º feed é histórico (nada pulsa).
 */
import { CircleGeometry, Group, Mesh, MeshBasicMaterial, type Object3D } from 'three'
import { CENTRAL_ID, type CentralTarget } from '@shared/central'
import type { OfficeFeed } from '../office/adapter/feed'
import { principalKey, roomIdFor } from '../office/adapter/model'
import type { Office3DLayout } from './layout'
import { CONSOLE, DOOR, ISLAND_RUG, ISLANDS, PLAZA_RUG, RIGHT_FACE_X } from './officePlan'
import type { RoomLod } from './roomLod'

/** Velocidade do pulso (m/s) e quantos correm ao mesmo tempo. */
export const PULSE_SPEED = 3.2
const POOL = 4
const Y = 0.012

export interface Delivery {
  id: string
  target: CentralTarget
  /** A conversa onde a mensagem caiu (o destino de fato, quando há). */
  convId: string | null
}

/** As entradas entregues da Central (a conversa da Central vem no feed, com o estado dela). */
export function deliveredOf(feed: OfficeFeed | null): Delivery[] {
  const central = feed?.conversations.find((c) => c.id === CENTRAL_ID)?.central
  const out: Delivery[] = []
  for (const e of central?.entries ?? []) {
    if (e.kind !== 'request' || e.state !== 'delivered' || !e.route) continue
    const t = e.route.target
    out.push({ id: e.id, target: t, convId: e.anchor?.convId ?? (t.kind === 'conversation' ? t.convId : null) })
  }
  return out
}

/** As entregas novas desde o feed anterior (o 1º feed é histórico). */
export class PulseTracker {
  private seen: Set<string> | null = null

  update(list: readonly Delivery[]): Delivery[] {
    const ids = new Set(list.map((d) => d.id))
    if (!this.seen) {
      this.seen = ids
      return []
    }
    const fresh = list.filter((d) => !this.seen!.has(d.id))
    this.seen = ids
    return fresh
  }
}

export interface PulseTarget {
  x: number
  z: number
  /** A ilha por onde o pulso passa (a trilha dela); null = direto (a porta). */
  island: number | null
}

const nearestIsland = (x: number, z: number): number => ISLANDS.reduce((best, i) => (Math.hypot(i.x - x, i.z - z) < Math.hypot(ISLANDS[best].x - x, ISLANDS[best].z - z) ? i.index : best), 0)

/** O ponto de chegada: a mesa do principal, a ilha do projeto ou a porta. */
export function pulseTarget(d: Delivery, layout: Office3DLayout): PulseTarget {
  const door: PulseTarget = { x: RIGHT_FACE_X - 0.3, z: DOOR.z, island: null }
  if (d.target.kind === 'new-sandbox') return door
  if (d.target.kind === 'new-conversation') {
    const island = layout.islandOf[roomIdFor(d.target.cwd)]?.[0]
    return island === undefined ? door : { x: ISLANDS[island].x, z: ISLANDS[island].z, island }
  }
  const c = d.convId ? layout.characters.find((x) => x.key === principalKey(d.convId!)) : undefined
  if (!c) return door
  const desk = c.deskIndex !== null ? layout.rooms[0]?.desks[c.deskIndex] : undefined
  const at = desk ?? { x: c.x, z: c.z }
  return { x: at.x, z: at.z, island: desk ? desk.island : nearestIsland(at.x, at.z) }
}

/** O caminho (x, z, x, z…) do console até o destino, pela trilha. */
export function pulsePath(t: PulseTarget, out: number[] = []): number[] {
  out.length = 0
  if (t.island === null) {
    // Pela trilha da porta: sai do tapete da praça para a direita.
    out.push(CONSOLE.x + CONSOLE.r, CONSOLE.z, PLAZA_RUG.x + PLAZA_RUG.r, DOOR.z, t.x, t.z)
    return out
  }
  const isl = ISLANDS[t.island]
  const dx = isl.x - CONSOLE.x
  const dz = isl.z + ISLAND_RUG.dz - CONSOLE.z
  const d = Math.hypot(dx, dz)
  const ux = dx / d
  const uz = dz / d
  const rIsl = 1 / Math.hypot(ux / ISLAND_RUG.rx, uz / ISLAND_RUG.rz)
  out.push(CONSOLE.x + ux * CONSOLE.r, CONSOLE.z + uz * CONSOLE.r, CONSOLE.x + ux * (d - rIsl), CONSOLE.z + uz * (d - rIsl), t.x, t.z)
  return out
}

interface Runner {
  mesh: Mesh
  path: number[]
  len: number
  at: number
}

export class CentralPulses {
  readonly group = new Group()
  private readonly geo = new CircleGeometry(0.16, 20)
  private readonly mat = new MeshBasicMaterial({ color: 0xf5f2d8, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false })
  private readonly runners: Runner[] = []
  private readonly tracker = new PulseTracker()
  private lod: RoomLod | null = null
  /** O agente da Central faz o gesto de enviar (o motor liga). */
  onSend: () => void = () => {}

  constructor(parent: Object3D) {
    this.group.name = 'central-pulses'
    for (let i = 0; i < POOL; i++) {
      const mesh = new Mesh(this.geo, this.mat)
      mesh.rotation.x = -Math.PI / 2
      mesh.visible = false
      mesh.renderOrder = 2
      this.group.add(mesh)
      this.runners.push({ mesh, path: [], len: 0, at: 0 })
    }
    parent.add(this.group)
  }

  /** Feed novo: as entregas novas viram pulsos (`lod` = a zona da praça, para saber se está à vista). */
  feed(feed: OfficeFeed | null, layout: Office3DLayout, lod: RoomLod | null): void {
    this.lod = lod
    for (const d of this.tracker.update(deliveredOf(feed))) {
      const r = this.runners.find((x) => !x.mesh.visible) ?? this.runners[0]
      pulsePath(pulseTarget(d, layout), r.path)
      let len = 0
      for (let i = 2; i < r.path.length; i += 2) len += Math.hypot(r.path[i] - r.path[i - 2], r.path[i + 1] - r.path[i - 1])
      r.len = len
      r.at = 0
      r.mesh.visible = true
      this.place(r)
      this.onSend()
    }
  }

  private place(r: Runner): void {
    let left = r.at
    const p = r.path
    for (let i = 2; i < p.length; i += 2) {
      const seg = Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1])
      if (left <= seg || i === p.length - 2) {
        const k = seg > 0 ? Math.min(1, left / seg) : 1
        r.mesh.position.set(p[i - 2] + (p[i] - p[i - 2]) * k, Y, p[i - 1] + (p[i + 1] - p[i - 1]) * k)
        return
      }
      left -= seg
    }
  }

  /** Um quadro: anda os pulsos; fora da tela, terminam na hora. true enquanto algum corre. */
  animate(dt: number): boolean {
    let moving = false
    const hidden = this.lod?.culled ?? false
    for (const r of this.runners) {
      if (!r.mesh.visible) continue
      r.at += PULSE_SPEED * dt
      if (hidden || r.at >= r.len) {
        r.mesh.visible = false
        continue
      }
      this.place(r)
      moving = true
    }
    return moving
  }

  /** Quantos estão correndo (testes e HUD). */
  get running(): number {
    return this.runners.filter((r) => r.mesh.visible).length
  }

  dispose(): void {
    this.group.removeFromParent()
    this.geo.dispose()
    this.mat.dispose()
  }
}
