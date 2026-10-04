/**
 * Energia do escritório na cena: junta o quadro de energia (energyPanel.ts), a
 * luz POR ZONA (zonePower.ts, com as funções de tempo de blackout.ts), a festa
 * (party.ts + o crowd) e as três luzes de sempre. A cena chama `setPower` a
 * cada leitura (feed ou tique), `syncRooms` quando o escritório é montado,
 * `updateView` com a câmera e `animate` por quadro.
 *
 * Transições: 'apagao' começa a queda zona a zona (LIGHTS_OUT_S; a 1ª é a mais
 * perto do quadro de energia, island1) e liga a festa; 'luz-voltou' acende
 * zona a zona (LIGHTS_BACK_S), desliga a festa e manda todo mundo para a mesa.
 * Sem evento (1º retrato já no apagão), o estado entra direto, sem animar.
 *
 * Desempenho: o estado de cada zona é uma função do relógio (nada acumula), então
 * zona fora da tela não é processada — só o "escuro" dela (monitores) é
 * acompanhado, e muda raramente (`onDark`). Ritmo pedido: 2 na transição e na
 * festa à vista, 1 (~30 quadros/s) para piscadas, giroflex, emergência e
 * pulsos do eletroduto, 0 parado.
 */
import { Vector3, type AmbientLight, type DirectionalLight, type HemisphereLight, type Scene } from 'three'
import type { Brain } from './brainBody'
import { flicker, LIGHTS_BACK_S, LIGHTS_OUT_S, roomLight, SceneLights, seedOfId } from './blackout'
import type { Crowd } from './crowd'
import type { RoomView, ZoneView } from './decor'
import { EnergyPanel, PANEL_SPOT } from './energyPanel'
import { createEnergyKit, type EnergyKit } from './energyKit'
import type { Kit } from './kit'
import type { RoomLayout } from './layout'
import { ZONES, zoneAt, type ZoneId } from './officePlan'
import { PartyPools, PizzaBox, type PartyZone } from './party'
import type { Particles } from './particles'
import type { OfficePower, PowerEvent, PowerLevel } from './power'
import { OfficePowerMeshes, ZonePowerFx } from './zonePower'

interface ZoneEnergy {
  readonly id: ZoneId
  readonly zone: ZoneView
  readonly fx: ZonePowerFx
  readonly party: PartyZone
  readonly seed: number
  /** Posição na fila das transições (0 = mais perto do quadro de energia). */
  order: number
}

export interface SceneLightRefs {
  hemi: HemisphereLight
  amb: AmbientLight
  sun: DirectionalLight
}

/** Aviões só sobre o piso da zona (longe das paredes). */
const PLANE_MARGIN = 0.5

export class OfficeEnergy {
  readonly kit: EnergyKit
  readonly plant: EnergyPanel
  private readonly pools: PartyPools
  private readonly pizza: PizzaBox
  private readonly lights: SceneLights
  private view: RoomView | null = null
  /** Emergências, halos, luar, SAÍDA e o escurecimento único (uma chamada cada, na casca). */
  private shared: OfficePowerMeshes | null = null
  private list: ZoneEnergy[] = []
  /** A luz de cada zona neste quadro (reaproveitado). */
  private lights01 = new Float32Array(0)
  private partyList: PartyZone[] = []
  private readonly byId = new Map<ZoneId, ZoneEnergy>()
  /** Quem dança à vista (reaproveitada a cada quadro: o confete sai de um deles). */
  private readonly dancers: Brain[] = []
  private power: OfficePower | null = null
  /** Nível que a luz segue (na volta, já o novo). */
  private level: PowerLevel = 'cheia'
  /** Apagão ou voltando dele: luar, emergência e SAÍDA valem nas zonas escuras. */
  private outage = false
  private trans: { kind: 'out' | 'back'; t0: number } | null = null
  private lastG = -1
  private lastLevel: PowerLevel | null = null
  /** Céu da parede de vidro: 1 noite (luar), 0 o da hora. */
  private night = -1
  /** Plano da festa já refletido na caixa de pizza. */
  private planSeen = -1
  /** Uma zona apagou/acendeu de vez (monitores e brilho no rosto). */
  onDark: (zone: ZoneId, dark: boolean) => void = () => {}

  constructor(
    private readonly scene: Scene,
    private readonly sceneKit: Kit,
    private readonly particles: Particles,
    private readonly crowd: Crowd,
    lights: SceneLightRefs
  ) {
    this.kit = createEnergyKit()
    this.plant = new EnergyPanel(sceneKit, this.kit)
    this.pools = new PartyPools(this.kit, scene)
    this.pizza = new PizzaBox(sceneKit, this.kit)
    this.lights = new SceneLights(lights.hemi, lights.amb, lights.sun)
  }

  /** Nível atual da luz (o efetivo, com o override de DEV). */
  get currentLevel(): PowerLevel {
    return this.level
  }

  /** A zona está no escuro do apagão (monitor preto, rosto sem brilho). */
  zoneDark(id: ZoneId): boolean {
    return this.byId.get(id)?.fx.dark ?? false
  }

  /** O escritório foi montado (ou refeito): cada zona do piso ganha os efeitos; o quadro vai para a zona dele. */
  syncRooms(layout: readonly RoomLayout[], views: ReadonlyMap<string, RoomView>): void {
    const view = layout[0] ? views.get(layout[0].id) : undefined
    if (view === this.view) return
    this.dropZones()
    this.view = view ?? null
    if (!view) return
    const shared = new OfficePowerMeshes(this.sceneKit, this.kit, view.zone('shell').group)
    this.shared = shared
    for (const { id, rect } of ZONES) {
      const zone = view.zone(id)
      const lamps = view.lamps.filter((l) => l.zone === id)
      const fx = new ZonePowerFx(this.sceneKit, this.kit, zone, lamps, shared)
      const bounds = { x0: rect.x0 + PLANE_MARGIN, x1: rect.x1 - PLANE_MARGIN, z0: rect.z0 + PLANE_MARGIN, z1: rect.z1 - PLANE_MARGIN }
      const ze: ZoneEnergy = { id, zone, fx, party: { bounds, eligible: false }, seed: seedOfId(id), order: 0 }
      this.list.push(ze)
      this.byId.set(id, ze)
    }
    this.partyList = this.list.map((z) => z.party)
    this.lights01 = new Float32Array(this.list.length)
    // A fila das transições sai do quadro de energia: a zona mais perto apaga (e acende) primeiro.
    const panel = new Vector3(PANEL_SPOT.x, 1, PANEL_SPOT.z)
    const dist = (z: ZoneEnergy): number => z.zone.lod.box.distanceToPoint(panel)
    ;[...this.list].sort((a, b) => dist(a) - dist(b) || a.id.localeCompare(b.id)).forEach((z, i) => (z.order = i))
    this.plant.attach(view.zone(zoneAt(PANEL_SPOT.x, PANEL_SPOT.z)))
    this.plant.setPower(this.power, Date.now())
    this.planSeen = -1
    this.lastG = -1
    this.night = -1
  }

  private dropZones(): void {
    for (const z of this.list) z.fx.dispose()
    this.shared?.dispose()
    this.shared = null
    this.list = []
    this.partyList = []
    this.byId.clear()
  }

  /**
   * Leitura nova da energia. `event` (powerEvents) começa as transições; `t` =
   * relógio da cena (s); `now` = epoch ms (hora do reset no painel).
   */
  setPower(power: OfficePower | null, event: PowerEvent | null, t: number, now: number): void {
    this.power = power
    const level = power?.level ?? 'cheia'
    if (event === 'apagao') this.trans = { kind: 'out', t0: t }
    else if (event === 'luz-voltou') this.trans = { kind: 'back', t0: t }
    else if (level !== this.level && (level === 'apagao' || this.level === 'apagao')) this.trans = null
    this.level = level
    this.outage = level === 'apagao' || this.trans?.kind === 'back'
    const party = level === 'apagao'
    if (party !== this.crowd.partyOn) this.crowd.setParty(party, t)
    this.plant.setPower(power, now)
  }

  /** A câmera mudou: o quadro de energia segue o culling/LOD da zona dele. */
  updateView(): void {
    this.plant.updateView()
  }

  /** Luz (0..1) da zona no instante `t`: transição, piscada do alerta ou o nível. */
  private lightOf(z: ZoneEnergy, t: number): number {
    const tr = this.trans
    if (tr) return roomLight(tr.kind, t - tr.t0, z.order, this.list.length, z.seed)
    if (this.level === 'apagao') return 0
    if (this.level === 'alerta') return flicker(z.seed, t)
    return 1
  }

  /** Um quadro; devolve o ritmo pedido (2 cheio, 1 baixo, 0 parado). */
  animate(t: number, dt: number): 0 | 1 | 2 {
    const tr = this.trans
    if (tr && t - tr.t0 > (tr.kind === 'out' ? LIGHTS_OUT_S : LIGHTS_BACK_S) + 0.05) {
      this.trans = null
      this.outage = this.level === 'apagao'
    }
    // Papéis novos (o crowd planeja no passo): a caixa de pizza vai para a cadeira de quem come.
    if (this.crowd.planVersion !== this.planSeen) {
      this.planSeen = this.crowd.planVersion
      const desk = this.crowd.partyOn ? this.crowd.pizzaDesk() : null
      this.pizza.set(desk, desk ? (this.view?.zone(zoneAt(desk.x, desk.z)).group ?? null) : null)
    }
    let full = false
    let low = false
    let sum = 0
    let anyDark = false
    // Todas as zonas com a mesma luz (o apagão parado, a economia): um escurecimento só para o escritório.
    let uniform = true
    for (let i = 0; i < this.list.length; i++) {
      this.lights01[i] = this.lightOf(this.list[i], t)
      if (Math.abs(this.lights01[i] - this.lights01[0]) > 1e-3) uniform = false
    }
    let anyEmergency = false
    let anyMoon = false
    let door: ZoneEnergy | null = null
    for (let i = 0; i < this.list.length; i++) {
      const z = this.list[i]
      const light = this.lights01[i]
      sum += light
      const wasDark = z.fx.dark
      const lod = z.zone.lod
      const visible = !lod.culled
      if (visible) z.fx.apply(this.level, light, this.outage, lod.level, t, !uniform)
      else {
        z.fx.track(light, this.outage)
        z.fx.hide()
      }
      if (z.fx.dark !== wasDark) this.onDark(z.id, z.fx.dark)
      if (this.outage && light < 0.5) anyDark = true
      if (z.fx.emergency) anyEmergency = true
      if (z.fx.moonK > 0.02) anyMoon = true
      if (z.id === this.view?.doorZone.id) door = z
      z.party.eligible = this.crowd.partyOn && visible && lod.level < 2
      if (!visible) continue
      if (this.trans) full = true
      else if (this.level === 'alerta' || this.outage) low = true
      if (z.party.eligible) full = true
    }
    const shared = this.shared
    if (shared) {
      const dim = this.list[0]?.fx.dim ?? 0
      shared.dimAll.visible = uniform && dim > 0.004
      ;(shared.dimAll.material as { opacity: number }).opacity = dim
      shared.setExit(!!door && door.fx.emergency && !door.zone.lod.culled && door.zone.lod.level < 2)
      shared.flush(anyEmergency, anyMoon)
    }
    // O céu atrás do vidro: noite (com lua) enquanto alguma zona está no escuro do apagão.
    const night = anyDark ? 1 : 0
    if (night !== this.night && this.view) {
      this.night = night
      for (const s of this.view.skies) s.material = night ? this.sceneKit.mat.skyNight : this.sceneKit.mat.sky
    }
    const g = this.list.length > 0 ? sum / this.list.length : 1
    if (this.trans || this.level !== this.lastLevel || Math.abs(g - this.lastG) > 0.002) {
      this.lastLevel = this.level
      this.lastG = g
      this.lights.apply(this.level, this.outage && !this.trans ? 0 : g)
    }
    this.dancers.length = 0
    if (this.crowd.partyOn) for (const b of this.crowd.list) if (b.party === 'dance' && b.visible && b.arrived) this.dancers.push(b)
    if (this.pools.animate(t, dt, this.partyList, this.dancers)) full = true
    if (this.plant.animate(t, dt, this.particles) === 1) low = true
    return full ? 2 : low ? 1 : 0
  }

  dispose(): void {
    this.dropZones()
    this.view = null
    this.pools.dispose()
    this.pizza.dispose()
    this.plant.dispose()
    this.kit.dispose()
    this.onDark = () => {}
  }
}
