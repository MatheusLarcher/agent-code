/**
 * Os efeitos de energia do escritório (three), POR ZONA no estado e no
 * escurecimento, e com as malhas que brilham no escuro compartilhadas (uma
 * chamada cada para o escritório inteiro):
 *   - por zona (ZonePowerFx, no grupo dela — some junto no culling): o
 *     escurecimento translúcido sobre o retângulo da zona e as luminárias dela
 *     (trocam de material);
 *   - no escritório (OfficePowerMeshes, na casca): as caixinhas vermelhas de
 *     emergência no alto de uma parede de cada zona e os halos delas, o luar
 *     entrando pela parede de vidro (só nas zonas encostadas nela), a placa
 *     verde de SAÍDA em cima da porta e o escurecimento único do apagão parado
 *     (todas as zonas iguais: uma chamada em vez de uma por zona).
 * Cada zona acende/apaga os seus pedaços pela cor das instâncias (aditivo:
 * preto some). Nenhuma luz é criada; as funções de tempo são as de blackout.ts.
 */
import { Color, InstancedMesh, Mesh, MeshBasicMaterial, Object3D, type Group } from 'three'
import { ORDER_DIM, ORDER_GLOW, type EnergyKit } from './energyKit'
import type { Lamp } from './decorBack'
import type { ZoneView } from './decor'
import type { Kit } from './kit'
import type { Lod } from './lod'
import { BACK_FACE_Z, DOOR, GLASS_X, OFFICE, RIGHT_FACE_X, ZONES, type Rect, type ZoneId } from './officePlan'
import type { PowerLevel } from './power'

/** Altura do escurecimento (acima das cabeças, abaixo do alto das paredes). */
export const DIM_Y = 1.8
/** O escurecimento passa da borda do escritório (quem está na beira, a porta). */
const DIM_MARGIN = 0.8
/** Escurecimento por nível com a zona ligada; no escuro, DARK_DIM. */
const LEVEL_DIM: Readonly<Record<PowerLevel, number>> = { cheia: 0, economia: 0.05, alerta: 0.08, apagao: 0.34 }
export const DARK_DIM = 0.34
/** Um facho de luar a cada tantos metros de vidro. */
const MOON_STEP = 1.9

type FloorZone = Exclude<ZoneId, 'shell'>

/** Uma luz de emergência (caixa + halo) ou a SAÍDA: posição e para onde olha (ry 0 = +Z). */
interface Fixture {
  x: number
  y: number
  z: number
  ry: number
}

const BACK = BACK_FACE_Z + 0.04
const RIGHT = RIGHT_FACE_X - 0.04
const GLASS = GLASS_X + 0.12
const FACE_IN = -Math.PI / 2
const FACE_OUT = Math.PI / 2

/** Emergências de cada zona: no alto da parede do fundo, da direita ou na viga do vidro. */
const EMERGENCY: Readonly<Record<FloorZone, readonly Fixture[]>> = {
  lounge: [{ x: -7.4, y: 2.45, z: BACK, ry: 0 }, { x: -3.0, y: 2.45, z: BACK, ry: 0 }],
  plaza: [{ x: -1.45, y: 2.45, z: BACK, ry: 0 }, { x: 1.1, y: 2.45, z: BACK, ry: 0 }],
  meeting: [{ x: 3.2, y: 2.45, z: BACK, ry: 0 }, { x: 7.6, y: 2.45, z: BACK, ry: 0 }],
  island3: [{ x: RIGHT, y: 1.98, z: -1.2, ry: FACE_IN }, { x: RIGHT, y: 1.98, z: 1.8, ry: FACE_IN }],
  island1: [{ x: RIGHT, y: 1.98, z: 5.95, ry: FACE_IN }],
  island2: [{ x: GLASS, y: 2.45, z: 0.4, ry: FACE_OUT }],
  island0: [{ x: GLASS, y: 2.45, z: 6.5, ry: FACE_OUT }]
}
/** A SAÍDA, em cima da porta (na zona dela). */
const EXIT: Fixture = { x: RIGHT_FACE_X - 0.03, y: DOOR.height + 0.12, z: DOOR.z, ry: FACE_IN }

const dummy = new Object3D()
dummy.rotation.order = 'YXZ'
const RED = new Color(0xff2a2a)
const RED_LOW = new Color(0xff2a2a).multiplyScalar(0.12)
const GREEN = new Color(0x22e07a)
const BLACK = new Color(0x000000)
const scratch = new Color()

const rectOf = (id: ZoneId): Rect => (id === 'shell' ? OFFICE : ZONES.find((z) => z.id === id)!.rect)

/** Os fachos de luar de uma zona (z de cada um); vazio se ela não encosta no vidro. */
function panesOf(id: ZoneId): number[] {
  const r = rectOf(id)
  const out: number[] = []
  if (r.x0 <= OFFICE.x0) for (let z = r.z0 + MOON_STEP / 2; z < r.z1; z += MOON_STEP) out.push(z)
  return out
}

/** As malhas que brilham no escuro, uma de cada para o escritório inteiro (na casca). */
export class OfficePowerMeshes {
  readonly boxes: InstancedMesh
  readonly glows: InstancedMesh
  readonly moon: InstancedMesh
  readonly exit: Mesh
  /** O escurecimento único do apagão parado (todas as zonas no mesmo tom). */
  readonly dimAll: Mesh
  private readonly dimAllMat: MeshBasicMaterial
  /** Onde começam as instâncias de cada zona (emergências, luar) e o halo da SAÍDA. */
  readonly glowAt = new Map<ZoneId, { from: number; n: number }>()
  readonly moonAt = new Map<ZoneId, { from: number; n: number }>()
  readonly exitGlow: number
  private glowDirty = false
  private moonDirty = false

  constructor(kit: Kit, ek: EnergyKit, parent: Group) {
    const fixtures: Fixture[] = []
    const panes: number[] = []
    for (const { id } of ZONES) {
      const list = EMERGENCY[id as FloorZone]
      this.glowAt.set(id, { from: fixtures.length, n: list.length })
      fixtures.push(...list)
      const p = panesOf(id)
      this.moonAt.set(id, { from: panes.length, n: p.length })
      panes.push(...p)
    }
    this.exitGlow = fixtures.length
    this.boxes = new InstancedMesh(kit.geo.box, ek.mat.emergency, fixtures.length)
    this.glows = new InstancedMesh(kit.geo.plane, ek.mat.glow, fixtures.length + 1)
    fixtures.forEach((f, i) => {
      dummy.rotation.set(0, f.ry, 0)
      dummy.position.set(f.x, f.y, f.z)
      dummy.scale.set(0.16, 0.08, 0.06)
      dummy.updateMatrix()
      this.boxes.setMatrixAt(i, dummy.matrix)
      this.boxes.setColorAt(i, RED)
      dummy.position.set(f.x + Math.sin(f.ry) * 0.07, f.y, f.z + Math.cos(f.ry) * 0.07)
      dummy.scale.set(0.95, 0.95, 1)
      dummy.updateMatrix()
      this.glows.setMatrixAt(i, dummy.matrix)
      this.glows.setColorAt(i, BLACK)
    })
    dummy.rotation.set(0, EXIT.ry, 0)
    dummy.position.set(EXIT.x - 0.02, EXIT.y, EXIT.z)
    dummy.scale.set(1.25, 0.6, 1)
    dummy.updateMatrix()
    this.glows.setMatrixAt(this.exitGlow, dummy.matrix)
    this.glows.setColorAt(this.exitGlow, BLACK)
    // Luar: um facho inclinado do vidro até o chão e a mancha no chão, por vão de vidro.
    this.moon = new InstancedMesh(kit.geo.plane, ek.mat.moon, Math.max(1, panes.length * 2))
    panes.forEach((z, i) => {
      dummy.position.set(GLASS_X + 1.1, 1.0, z)
      dummy.rotation.set(-Math.atan2(2.2, 2.0), Math.PI / 2, 0)
      dummy.scale.set(1.3, Math.hypot(2.2, 2.0), 1)
      dummy.updateMatrix()
      this.moon.setMatrixAt(i * 2, dummy.matrix)
      dummy.position.set(GLASS_X + 2.2, 0.014, z)
      dummy.rotation.set(-Math.PI / 2, 0, 0)
      dummy.scale.set(1.1, 1.3, 1)
      dummy.updateMatrix()
      this.moon.setMatrixAt(i * 2 + 1, dummy.matrix)
      this.moon.setColorAt(i * 2, BLACK)
      this.moon.setColorAt(i * 2 + 1, BLACK)
    })
    this.exit = new Mesh(kit.geo.plane, ek.mat.exit)
    this.exit.position.set(EXIT.x, EXIT.y, EXIT.z)
    this.exit.rotation.y = EXIT.ry
    this.exit.scale.set(0.62, 0.23, 1)
    this.dimAllMat = ek.mat.dimmer.clone()
    this.dimAllMat.opacity = DARK_DIM
    this.dimAll = new Mesh(kit.geo.plane, this.dimAllMat)
    this.dimAll.rotation.x = -Math.PI / 2
    this.dimAll.scale.set(OFFICE.x1 - OFFICE.x0 + DIM_MARGIN * 2, OFFICE.z1 - OFFICE.z0 + DIM_MARGIN * 2, 1)
    this.dimAll.position.set((OFFICE.x0 + OFFICE.x1) / 2, DIM_Y, (OFFICE.z0 + OFFICE.z1) / 2)
    this.dimAll.renderOrder = ORDER_DIM
    for (const o of [this.glows, this.moon, this.exit]) o.renderOrder = ORDER_GLOW
    for (const o of [this.glows, this.moon]) o.frustumCulled = false
    for (const o of this.parts()) {
      o.visible = false
      parent.add(o)
    }
  }

  private parts(): Array<Mesh | InstancedMesh> {
    return [this.boxes, this.glows, this.moon, this.exit, this.dimAll]
  }

  /** A emergência da zona: halos piscando (alternados, `left`) ou apagados (preto). */
  setEmergency(zone: ZoneId, on: boolean, left: boolean): void {
    const at = this.glowAt.get(zone)
    if (!at) return
    for (let i = 0; i < at.n; i++) this.glows.setColorAt(at.from + i, !on ? BLACK : left === (i % 2 === 0) ? RED : RED_LOW)
    this.glowDirty = true
  }

  /** O halo da SAÍDA (preto: apagado). */
  setExit(on: boolean): void {
    this.glows.setColorAt(this.exitGlow, on ? GREEN : BLACK)
    this.exit.visible = on
    this.glowDirty = true
  }

  /** O luar da zona com força `k` (0 some). */
  setMoon(zone: ZoneId, k: number): void {
    const at = this.moonAt.get(zone)
    if (!at || at.n === 0) return
    scratch.setRGB(k, k, k)
    for (let i = at.from * 2; i < (at.from + at.n) * 2; i++) this.moon.setColorAt(i, scratch)
    this.moonDirty = true
  }

  /** Fim do quadro: sobe as cores mudadas e mostra só o que tem algo aceso. */
  flush(anyEmergency: boolean, anyMoon: boolean): void {
    this.boxes.visible = this.glows.visible = anyEmergency || this.exit.visible
    this.moon.visible = anyMoon
    if (this.glowDirty && this.glows.instanceColor) this.glows.instanceColor.needsUpdate = true
    if (this.moonDirty && this.moon.instanceColor) this.moon.instanceColor.needsUpdate = true
    this.glowDirty = this.moonDirty = false
  }

  dispose(): void {
    for (const o of this.parts()) o.removeFromParent()
    this.dimAllMat.dispose()
    this.boxes.dispose()
    this.glows.dispose()
    this.moon.dispose()
  }
}

export class ZonePowerFx {
  readonly id: ZoneId
  /** Energia atual da zona (1 ligada … 0 escuro). */
  light = 1
  /** No escuro do apagão (monitores pretos, emergência ligada). */
  dark = false
  /** Emergência e luar desta zona neste quadro (o escritório junta). */
  emergency = false
  moonK = 0
  /** Escurecimento desta zona neste quadro (o escritório usa o único se todas iguais). */
  dim = 0
  private readonly dimMat: MeshBasicMaterial
  private readonly dimmer: Mesh
  private lampsOn = -1
  private moonShown = -1
  private emergencyShown: boolean | null = null

  constructor(
    private readonly kit: Kit,
    ek: EnergyKit,
    zone: ZoneView,
    /** As luminárias da zona (cúpula e lâmpada trocam de material). */
    private readonly lamps: readonly Lamp[],
    private readonly shared: OfficePowerMeshes
  ) {
    this.id = zone.id
    const r = rectOf(zone.id)
    // O escurecimento cobre o retângulo da zona; passa da borda só onde ela é a borda do escritório.
    const x0 = r.x0 - (r.x0 <= OFFICE.x0 ? DIM_MARGIN : 0)
    const x1 = r.x1 + (r.x1 >= OFFICE.x1 ? DIM_MARGIN : 0)
    const z0 = r.z0 - (r.z0 <= OFFICE.z0 ? DIM_MARGIN : 0)
    const z1 = r.z1 + (r.z1 >= OFFICE.z1 ? DIM_MARGIN : 0)
    this.dimMat = ek.mat.dimmer.clone()
    this.dimmer = new Mesh(kit.geo.plane, this.dimMat)
    this.dimmer.rotation.x = -Math.PI / 2
    this.dimmer.scale.set(x1 - x0, z1 - z0, 1)
    this.dimmer.position.set((x0 + x1) / 2, DIM_Y, (z0 + z1) / 2)
    this.dimmer.renderOrder = ORDER_DIM
    this.dimmer.visible = false
    zone.group.add(this.dimmer)
  }

  /**
   * Só o estado (zona fora da tela): a energia e se ela está no escuro. Os
   * monitores apagam quando a zona apaga de vez e voltam só com a luz inteira —
   * a tremida não pisca a tela.
   */
  track(light: number, outage: boolean): void {
    this.light = light
    if (outage && light < 0.05) this.dark = true
    else if (!outage || light >= 0.95) this.dark = false
  }

  /**
   * Aplica a energia `light` (0..1) da zona: `level` = o nível do prédio (o da
   * luz que volta, durante a volta); `outage` = apagão ou voltando dele (luar e
   * emergência valem enquanto a zona estiver no escuro); `t` = relógio (piscar
   * da emergência); `ownDim`: o escurecimento é o desta zona (senão o único do
   * escritório cobre). Só toca no que muda (nada aloca).
   */
  apply(level: PowerLevel, light: number, outage: boolean, lod: Lod, t: number, ownDim: boolean): void {
    this.track(light, outage)
    const target: PowerLevel = level === 'apagao' ? 'alerta' : level
    this.dim = LEVEL_DIM[target] * light + DARK_DIM * (1 - light)
    this.dimMat.opacity = this.dim
    this.dimmer.visible = ownDim && this.dim > 0.004
    // Luminárias: todas acesas cheio, metade na economia/alerta, nenhuma no escuro.
    const all = this.lamps.length
    const on = light > 0.5 ? (target === 'cheia' ? all : Math.ceil(all / 2)) : 0
    if (on !== this.lampsOn) {
      this.lampsOn = on
      this.lamps.forEach((l, i) => {
        l.shade.material = i < on ? this.kit.mat.shade : this.kit.mat.shadeOff
        l.bulb.material = i < on ? this.kit.mat.bulb : this.kit.mat.bulbOff
      })
    }
    // Luar fora do LONGE; emergência no escuro, em qualquer distância (alternando ~1,1 Hz).
    const moon = outage && lod < 2 ? 1 - light : 0
    this.moonK = moon
    if (Math.abs(moon - this.moonShown) > 0.02 || (moon === 0 && this.moonShown !== 0)) {
      this.moonShown = moon
      this.shared.setMoon(this.id, moon)
    }
    this.emergency = outage && light < 0.5
    if (this.emergency || this.emergencyShown !== false) {
      this.emergencyShown = this.emergency
      this.shared.setEmergency(this.id, this.emergency, Math.sin(t * Math.PI * 2.2) > 0)
    }
  }

  /** Fora da tela: nada desta zona brilha (a emergência e o luar dela apagam nas malhas do escritório). */
  hide(): void {
    this.dimmer.visible = false
    this.emergency = false
    this.moonK = 0
    if (this.moonShown !== 0) {
      this.moonShown = 0
      this.shared.setMoon(this.id, 0)
    }
    if (this.emergencyShown !== false) {
      this.emergencyShown = false
      this.shared.setEmergency(this.id, false, false)
    }
  }

  dispose(): void {
    this.dimmer.removeFromParent()
    this.dimMat.dispose()
  }
}
