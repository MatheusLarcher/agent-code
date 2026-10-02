/**
 * Energia do escritório na cena: junta a usina (powerPlant.ts), a luz das
 * salas (blackout.ts), a festa (party.ts + o crowd) e as três luzes de sempre.
 * A cena chama `setPower` a cada leitura (feed ou tique), `syncRooms` quando as
 * salas mudam, `updateView` com o frustum e `animate` por quadro.
 *
 * Transições: 'apagao' começa a queda sala a sala (LIGHTS_OUT_S, a 1ª sala é a
 * mais perto da usina) e liga a festa; 'luz-voltou' acende sala a sala
 * (LIGHTS_BACK_S), desliga a festa e manda todo mundo para a mesa. Sem evento
 * (1º retrato já no apagão), o estado entra direto, sem animar.
 *
 * Desempenho: o estado de cada sala é uma função do relógio (nada acumula), então
 * sala fora da tela não é processada — só a "sala no escuro" (monitores) é
 * acompanhada em todas, e muda raramente (`onDark`). Ritmo pedido: 2 na
 * transição e na festa à vista, 1 (~30 quadros/s) para piscadas, giroflex,
 * emergência e pulsos do cabo, 0 parado.
 */
import type { AmbientLight, DirectionalLight, Frustum, HemisphereLight, Scene, Vector3 } from 'three'
import { flicker, LIGHTS_BACK_S, LIGHTS_OUT_S, RoomPowerFx, roomLight, SceneLights, seedOfId } from './blackout'
import type { Crowd } from './crowd'
import type { RoomView } from './decor'
import { createEnergyKit, type EnergyKit } from './energyKit'
import type { Kit } from './kit'
import type { RoomLayout } from './layout'
import { PartyPools, RoomPartyFx } from './party'
import type { Particles } from './particles'
import type { OfficePower, PowerEvent, PowerLevel } from './power'
import { plantSpot, PowerPlant } from './powerPlant'

interface RoomEnergy {
  readonly id: string
  readonly view: RoomView
  readonly fx: RoomPowerFx
  readonly party: RoomPartyFx
  readonly seed: number
  /** Posição na fila das transições (0 = mais perto da usina). */
  order: number
}

export interface SceneLightRefs {
  hemi: HemisphereLight
  amb: AmbientLight
  sun: DirectionalLight
}

export class OfficeEnergy {
  readonly kit: EnergyKit
  readonly plant: PowerPlant
  private readonly pools: PartyPools
  private readonly lights: SceneLights
  private readonly rooms = new Map<string, RoomEnergy>()
  private list: RoomEnergy[] = []
  private partyList: RoomPartyFx[] = []
  private power: OfficePower | null = null
  /** Nível que a luz segue (na volta, já o novo). */
  private level: PowerLevel = 'cheia'
  /** Apagão ou voltando dele: luar, emergência e SAÍDA valem nas salas escuras. */
  private outage = false
  private trans: { kind: 'out' | 'back'; t0: number } | null = null
  private lastG = -1
  private lastLevel: PowerLevel | null = null
  /** Plano da festa já refletido nas caixas de pizza. */
  private planSeen = -1
  /** Uma sala apagou/acendeu de vez (monitores e brilho no rosto). */
  onDark: (roomId: string, dark: boolean) => void = () => {}

  constructor(
    private readonly scene: Scene,
    private readonly sceneKit: Kit,
    private readonly particles: Particles,
    private readonly crowd: Crowd,
    lights: SceneLightRefs
  ) {
    this.kit = createEnergyKit()
    this.plant = new PowerPlant(sceneKit, this.kit)
    this.pools = new PartyPools(this.kit, scene)
    this.lights = new SceneLights(lights.hemi, lights.amb, lights.sun)
  }

  /** Nível atual da luz (o efetivo, com o override de DEV). */
  get currentLevel(): PowerLevel {
    return this.level
  }

  /** A sala está no escuro do apagão (monitor preto). */
  isDark(roomId: string | null): boolean {
    return roomId !== null && (this.rooms.get(roomId)?.fx.dark ?? false)
  }

  /** Salas novas ganham os efeitos; as que saíram (ou foram refeitas) liberam os delas; os cabos acompanham. */
  syncRooms(layout: readonly RoomLayout[], views: ReadonlyMap<string, RoomView>): void {
    for (const r of layout) {
      const view = views.get(r.id)
      const cur = this.rooms.get(r.id)
      if (!view || cur?.view === view) continue
      if (cur) this.drop(cur)
      const fx = new RoomPowerFx(this.sceneKit, this.kit, view, r)
      const party = new RoomPartyFx(this.sceneKit, this.kit, view.group, r, view.furniture.rug)
      this.rooms.set(r.id, { id: r.id, view, fx, party, seed: seedOfId(r.id), order: 0 })
    }
    const ids = new Set(layout.map((r) => r.id))
    for (const [id, re] of this.rooms) if (!ids.has(id) || views.get(id) !== re.view) this.drop(re)
    this.list = [...this.rooms.values()]
    this.partyList = this.list.map((r) => r.party)
    // A fila das transições sai da usina: a sala mais perto apaga (e acende) primeiro.
    const p = plantSpot(layout)
    const dist = (re: RoomEnergy): number => (p ? Math.hypot(re.view.lod.box.min.x - p.x, re.view.lod.box.min.z - p.z) : 0)
    ;[...this.list].sort((a, b) => dist(a) - dist(b)).forEach((re, i) => (re.order = i))
    this.plant.sync(layout, this.scene)
    this.plant.setPower(this.power, Date.now())
    for (const re of this.list) re.party.setOn(this.crowd.partyOn)
    this.planSeen = -1
    this.lastG = -1
  }

  private drop(re: RoomEnergy): void {
    re.fx.dispose()
    re.party.dispose()
    this.rooms.delete(re.id)
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
    if (party !== this.crowd.partyOn) {
      this.crowd.setParty(party, t)
      for (const re of this.list) re.party.setOn(party)
    }
    this.plant.setPower(power, now)
  }

  updateView(frustum: Frustum, cam: Vector3): void {
    this.plant.updateView(frustum, cam)
  }

  /** Luz (0..1) da sala no instante `t`: transição, piscada do alerta ou o nível. */
  private lightOf(re: RoomEnergy, t: number): number {
    const tr = this.trans
    if (tr) return roomLight(tr.kind, t - tr.t0, re.order, this.list.length, re.seed)
    if (this.level === 'apagao') return 0
    if (this.level === 'alerta') return flicker(re.seed, t)
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
      for (const re of this.list) re.party.setPizza(this.crowd.partyOn ? this.crowd.pizzaDesk(re.id) : null)
    }
    let full = false
    let low = false
    let sum = 0
    for (let i = 0; i < this.list.length; i++) {
      const re = this.list[i]
      const light = this.lightOf(re, t)
      sum += light
      const wasDark = re.fx.dark
      const visible = !re.view.lod.culled
      if (visible) re.fx.apply(this.level, light, this.outage, re.view.lod.level, t)
      else re.fx.track(light, this.outage)
      if (re.fx.dark !== wasDark) this.onDark(re.id, re.fx.dark)
      if (!visible) continue
      if (this.trans) full = true
      else if (this.level === 'alerta' || this.outage) low = true
      if (re.party.animate(t, dt, re.view.lod.level)) full = true
    }
    const g = this.list.length > 0 ? sum / this.list.length : 1
    if (this.trans || this.level !== this.lastLevel || Math.abs(g - this.lastG) > 0.002) {
      this.lastLevel = this.level
      this.lastG = g
      this.lights.apply(this.level, this.outage && !this.trans ? 0 : g)
    }
    if (this.pools.animate(t, dt, this.partyList, this.particles)) full = true
    const plant = this.plant.animate(t, dt, this.particles)
    if (plant === 1) low = true
    return full ? 2 : low ? 1 : 0
  }

  dispose(): void {
    for (const re of this.list) {
      re.fx.dispose()
      re.party.dispose()
    }
    this.rooms.clear()
    this.list = []
    this.partyList = []
    this.pools.dispose()
    this.plant.dispose()
    this.kit.dispose()
    this.onDark = () => {}
  }
}
