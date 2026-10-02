/**
 * Luz das salas pela energia do escritório (three + funções puras).
 *
 * Nenhuma luz é criada ou removida aqui: a cena tem as mesmas três desde o
 * início (hemisférica, ambiente e o sol) e só a intensidade e a cor delas
 * variam (`SceneLights`). O resto é malha: por sala, um escurecimento
 * translúcido logo acima das paredes (cobre a sala vista de cima e deixa a
 * transição "sala a sala"), o luar azul aditivo saindo das janelas, as luzes
 * de emergência vermelhas piscando e a placa verde de SAÍDA; as luminárias e o
 * céu das janelas só trocam de material.
 *
 *   cheia     tudo aceso;
 *   economia  luz um pouco menor e metade das luminárias apagadas;
 *   alerta    piscadas curtas e aleatórias por sala (`flicker`: seed
 *             determinística, no máximo 2 por FLICKER_SLOT_S);
 *   apagão    quase escuro, luar pelas janelas, monitores pretos, emergência e
 *             SAÍDA. Entra sala a sala com tremida (`roomLight` 'out', ~1,5 s)
 *             e volta sala a sala (`roomLight` 'back', ~2 s).
 * No LONGE, a sala no escuro fica só com o escurecimento e a emergência.
 */
import {
  Color,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  type AmbientLight,
  type DirectionalLight,
  type HemisphereLight,
  type Group
} from 'three'
import { ORDER_DIM, ORDER_GLOW, type EnergyKit } from './energyKit'
import type { RoomView } from './decor'
import type { Kit } from './kit'
import type { RoomLayout } from './layout'
import type { Lod } from './lod'
import type { PowerLevel } from './power'

/** Duração da queda (todas as salas) e da volta da luz. */
export const LIGHTS_OUT_S = 1.5
export const LIGHTS_BACK_S = 2
/** Quanto cada sala treme antes de apagar / ao acender. */
const OUT_FLICKER_S = 0.6
const BACK_FLICKER_S = 0.8
/** Piscadas do alerta: no máximo 2 por fatia. */
export const FLICKER_SLOT_S = 1.6
/** Altura do escurecimento (acima das paredes e das cabeças, abaixo da bola de discoteca). */
export const DIM_Y = 1.8
const DIM_MARGIN = 0.8
/** Escurecimento por nível com a sala ligada; no escuro, DARK_DIM. */
const LEVEL_DIM: Readonly<Record<PowerLevel, number>> = { cheia: 0, economia: 0.05, alerta: 0.08, apagao: 0.34 }
const DARK_DIM = 0.34
/** Luminárias acesas por sala em cada nível. */
const LAMPS_ON: Readonly<Record<PowerLevel, number>> = { cheia: 2, economia: 1, alerta: 1, apagao: 0 }

/** 0..1 determinístico por (seed, i). */
export function hash01(seed: number, i: number): number {
  const s = Math.sin(seed * 12.9898 + i * 78.233) * 43_758.5453
  return s - Math.floor(s)
}

/** Seed estável por id (FNV-1a), em 0..1000. */
export function seedOfId(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193)
  return ((h >>> 0) % 100_000) / 100
}

/**
 * Mau contato do alerta: 1 = luz normal, menos durante a piscada. Em cada
 * fatia de FLICKER_SLOT_S há no máximo duas piscadas curtas (50–150 ms), com
 * hora, duração e força tiradas da seed — a mesma seed pisca sempre igual.
 */
export function flicker(seed: number, t: number): number {
  const slot = Math.floor(t / FLICKER_SLOT_S)
  const u = t - slot * FLICKER_SLOT_S
  if (hash01(seed, slot * 5) > 0.55) return 1
  const start = 0.15 + hash01(seed, slot * 5 + 1) * (FLICKER_SLOT_S - 0.6)
  const dur = 0.05 + hash01(seed, slot * 5 + 2) * 0.1
  const depth = 0.35 + hash01(seed, slot * 5 + 3) * 0.5
  if (u >= start && u < start + dur) return 1 - depth
  if (hash01(seed, slot * 5 + 4) < 0.35) {
    const s2 = start + dur + 0.06
    if (u >= s2 && u < s2 + dur * 0.7) return 1 - depth * 0.8
  }
  return 1
}

/** Atraso de cada sala na fila da transição (a 1ª é a mais perto da usina). */
export function roomDelay(kind: 'out' | 'back', order: number, count: number): number {
  if (count <= 1) return 0
  const span = kind === 'out' ? LIGHTS_OUT_S - OUT_FLICKER_S : LIGHTS_BACK_S - BACK_FLICKER_S
  return (order * span) / (count - 1)
}

/**
 * Energia de uma sala `since` s depois do começo da transição: 1 ligada, 0 no
 * escuro. 'out': espera a vez, treme e apaga; 'back': espera a vez, pisca como
 * lâmpada fluorescente e acende.
 */
export function roomLight(kind: 'out' | 'back', since: number, order: number, count: number, seed: number): number {
  const local = since - roomDelay(kind, order, count)
  if (kind === 'out') {
    if (local < 0) return 1
    if (local >= OUT_FLICKER_S) return 0
    if (local < 0.45) return hash01(seed, 100 + Math.floor(local / 0.075)) > 0.45 ? 0.85 : 0.12
    return 0.3 * (1 - (local - 0.45) / (OUT_FLICKER_S - 0.45))
  }
  if (local < 0) return 0
  if (local >= BACK_FLICKER_S) return 1
  if (local < 0.6) return hash01(seed, 200 + Math.floor(local / 0.09)) > 0.5 ? 0.9 : 0.05
  return 0.6 + 0.4 * ((local - 0.6) / (BACK_FLICKER_S - 0.6))
}

// ── luzes da cena ──────────────────────────────────────────────────────────

interface LightSet {
  hemi: number
  sky: Color
  ground: Color
  amb: number
  ambColor: Color
  sun: number
  sunColor: Color
}

const DAY: LightSet = { hemi: 1.25, sky: new Color(0xfff1dc), ground: new Color(0x3a3040), amb: 0.2, ambColor: new Color(0xffe8d0), sun: 1.7, sunColor: new Color(0xffe2b8) }
/** Noite do apagão: escuro azulado, mas dá para ver a bagunça. */
const NIGHT: LightSet = { hemi: 0.62, sky: new Color(0x7d8fd6), ground: new Color(0x1a1a2c), amb: 0.1, ambColor: new Color(0x4a5aa8), sun: 0.55, sunColor: new Color(0x9fb4ff) }
/** Intensidade "de dia" por nível (a economia baixa um pouco, o alerta mais um pouco). */
const DAY_SCALE: Readonly<Record<PowerLevel, number>> = { cheia: 1, economia: 0.86, alerta: 0.8, apagao: 0.8 }

/** As três luzes de sempre: só intensidade e cor mudam com a energia. */
export class SceneLights {
  constructor(
    readonly hemi: HemisphereLight,
    readonly amb: AmbientLight,
    readonly sun: DirectionalLight
  ) {
    this.apply('cheia', 1)
  }

  /** `level` = como o prédio está ligado; `g` = fração ligada (1 dia do nível, 0 noite do apagão). */
  apply(level: PowerLevel, g: number): void {
    const k = Math.max(0, Math.min(1, g))
    const s = DAY_SCALE[level]
    this.hemi.intensity = NIGHT.hemi + (DAY.hemi * s - NIGHT.hemi) * k
    this.hemi.color.lerpColors(NIGHT.sky, DAY.sky, k)
    this.hemi.groundColor.lerpColors(NIGHT.ground, DAY.ground, k)
    this.amb.intensity = NIGHT.amb + (DAY.amb * s - NIGHT.amb) * k
    this.amb.color.lerpColors(NIGHT.ambColor, DAY.ambColor, k)
    this.sun.intensity = NIGHT.sun + (DAY.sun * s - NIGHT.sun) * k
    this.sun.color.lerpColors(NIGHT.sunColor, DAY.sunColor, k)
  }
}

// ── por sala ───────────────────────────────────────────────────────────────

const dummy = new Object3D()
const RED = new Color(0xff2a2a)
const GREEN = new Color(0x22e07a)
const MOON = new Color(0xffffff)
const scratch = new Color()

/** Os efeitos de energia de uma sala, presos no grupo dela (somem junto no culling). */
export class RoomPowerFx {
  readonly group: Group
  /** Energia atual da sala (1 ligada … 0 escuro). */
  light = 1
  /** No escuro do apagão (monitores pretos, emergência ligada). */
  dark = false
  private readonly dimMat: MeshBasicMaterial
  private readonly dimmer: Mesh
  private readonly moon: InstancedMesh
  private readonly boxes: InstancedMesh
  private readonly glows: InstancedMesh
  private readonly exit: Mesh
  private lampsOn = -1
  private moonK = -1
  /** Céu das janelas: 1 noite (luar), 0 o da hora. */
  private night = -1

  constructor(
    private readonly kit: Kit,
    ek: EnergyKit,
    private readonly view: RoomView,
    room: RoomLayout
  ) {
    this.group = view.group
    const { x, z, width: w, depth: d } = room
    const f = view.furniture
    this.dimMat = ek.mat.dimmer.clone()
    this.dimmer = new Mesh(kit.geo.plane, this.dimMat)
    this.dimmer.rotation.x = -Math.PI / 2
    this.dimmer.scale.set(w + DIM_MARGIN * 2, d + DIM_MARGIN * 2, 1)
    this.dimmer.position.set(x + w / 2, DIM_Y, z + d / 2)
    this.dimmer.renderOrder = ORDER_DIM
    this.dimmer.visible = false
    // Luar: um facho inclinado de cada janela até o chão e a mancha no chão.
    this.moon = new InstancedMesh(kit.geo.plane, ek.mat.moon, f.windows.length * 2)
    f.windows.forEach((win, i) => {
      dummy.position.set(win.x, 0.56, z + 1.06)
      dummy.rotation.set(Math.atan2(-1.88, 1.1), 0, 0)
      dummy.scale.set(1.3, 2.18, 1)
      dummy.updateMatrix()
      this.moon.setMatrixAt(i * 2, dummy.matrix)
      dummy.position.set(win.x, 0.014, z + 2.45)
      dummy.rotation.set(-Math.PI / 2, 0, 0)
      dummy.scale.set(1.3, 1.1, 1)
      dummy.updateMatrix()
      this.moon.setMatrixAt(i * 2 + 1, dummy.matrix)
      this.moon.setColorAt(i * 2, scratch.setRGB(0, 0, 0))
      this.moon.setColorAt(i * 2 + 1, scratch)
    })
    this.moon.renderOrder = ORDER_GLOW
    this.moon.frustumCulled = false
    // Emergência: duas caixinhas vermelhas no alto da parede do fundo (e o halo delas) + o halo da SAÍDA.
    const spots: Array<[number, number, number]> = [
      [x + 0.55, 1.64, z + 0.1],
      [x + w - 0.55, 1.64, z + 0.1]
    ]
    this.boxes = new InstancedMesh(kit.geo.box, ek.mat.emergency, 2)
    this.glows = new InstancedMesh(kit.geo.plane, ek.mat.glow, 3)
    spots.forEach(([px, py, pz], i) => {
      dummy.rotation.set(0, 0, 0)
      dummy.position.set(px, py, pz)
      dummy.scale.set(0.16, 0.08, 0.06)
      dummy.updateMatrix()
      this.boxes.setMatrixAt(i, dummy.matrix)
      this.boxes.setColorAt(i, RED)
      dummy.position.set(px, py, pz + 0.07)
      dummy.scale.set(0.95, 0.95, 1)
      dummy.updateMatrix()
      this.glows.setMatrixAt(i, dummy.matrix)
      this.glows.setColorAt(i, RED)
    })
    dummy.position.set(x + 0.04, 2.18, f.door.z + 0.02)
    dummy.scale.set(1.25, 0.6, 1)
    dummy.updateMatrix()
    this.glows.setMatrixAt(2, dummy.matrix)
    this.glows.setColorAt(2, GREEN)
    this.glows.renderOrder = ORDER_GLOW
    this.glows.frustumCulled = false
    this.exit = new Mesh(kit.geo.plane, ek.mat.exit)
    this.exit.position.set(x + 0.04, 2.18, f.door.z)
    this.exit.scale.set(0.62, 0.23, 1)
    this.exit.renderOrder = ORDER_GLOW
    for (const o of [this.moon, this.boxes, this.glows, this.exit]) o.visible = false
    this.group.add(this.dimmer, this.moon, this.boxes, this.glows, this.exit)
  }

  /**
   * Só o estado (sala fora da tela): a energia e se ela está no escuro. Os
   * monitores apagam quando a sala apaga de vez e voltam só com a luz inteira —
   * a tremida não pisca a tela.
   */
  track(light: number, outage: boolean): void {
    this.light = light
    if (outage && light < 0.05) this.dark = true
    else if (!outage || light >= 0.95) this.dark = false
  }

  /**
   * Aplica a energia `light` (0..1) da sala: `level` = o nível do prédio (o da
   * luz que volta, durante a volta); `outage` = apagão ou voltando dele (luar,
   * emergência e SAÍDA valem enquanto a sala estiver no escuro); `t` = relógio
   * (piscar da emergência). Só toca no que muda (nada aloca).
   */
  apply(level: PowerLevel, light: number, outage: boolean, lod: Lod, t: number): void {
    this.track(light, outage)
    const target: PowerLevel = level === 'apagao' ? 'alerta' : level
    const dim = LEVEL_DIM[target] * light + DARK_DIM * (1 - light)
    this.dimMat.opacity = dim
    this.dimmer.visible = dim > 0.004
    const on = light > 0.5 ? LAMPS_ON[target] : 0
    if (on !== this.lampsOn) {
      this.lampsOn = on
      this.view.lamps.forEach((l, i) => {
        l.shade.material = i < on ? this.kit.mat.shade : this.kit.mat.shadeOff
        l.bulb.material = i < on ? this.kit.mat.bulb : this.kit.mat.bulbOff
      })
    }
    const darkRoom = outage && light < 0.5
    const night = darkRoom ? 1 : 0
    if (night !== this.night) {
      this.night = night
      for (const s of this.view.skies) s.material = night ? this.kit.mat.skyNight : this.kit.mat.sky
    }
    // Luar e SAÍDA no escuro (fora do LONGE); emergência no escuro, em qualquer distância.
    const moon = outage && lod < 2 ? 1 - light : 0
    this.moon.visible = moon > 0.02
    if (this.moon.visible && Math.abs(moon - this.moonK) > 0.02) {
      this.moonK = moon
      scratch.copy(MOON).multiplyScalar(moon)
      for (let i = 0; i < this.moon.count; i++) this.moon.setColorAt(i, scratch)
      if (this.moon.instanceColor) this.moon.instanceColor.needsUpdate = true
    }
    const emergency = darkRoom
    this.boxes.visible = this.glows.visible = emergency
    this.exit.visible = emergency && lod < 2
    if (!emergency) return
    // Esquerda e direita alternam (~1,1 Hz); a SAÍDA fica acesa.
    const left = Math.sin(t * Math.PI * 2.2) > 0
    this.glows.setColorAt(0, scratch.copy(RED).multiplyScalar(left ? 1 : 0.12))
    this.glows.setColorAt(1, scratch.copy(RED).multiplyScalar(left ? 0.12 : 1))
    this.glows.setColorAt(2, lod < 2 ? GREEN : scratch.setRGB(0, 0, 0))
    if (this.glows.instanceColor) this.glows.instanceColor.needsUpdate = true
  }

  dispose(): void {
    this.group.remove(this.dimmer, this.moon, this.boxes, this.glows, this.exit)
    this.dimMat.dispose()
    this.moon.dispose()
    this.boxes.dispose()
    this.glows.dispose()
  }
}
