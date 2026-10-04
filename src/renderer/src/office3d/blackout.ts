/**
 * Luz do escritório pela energia (three + funções puras): o tempo da queda,
 * da volta e das piscadas de cada ZONA e as três luzes de sempre.
 *
 * Nenhuma luz é criada ou removida aqui: a cena tem as mesmas três desde o
 * início (hemisférica, ambiente e o sol) e só a intensidade e a cor delas
 * variam (`SceneLights`). O resto é malha, por zona (zonePower.ts): o
 * escurecimento, o luar pela parede de vidro, a emergência e a SAÍDA.
 *
 *   cheia     tudo aceso;
 *   economia  luz um pouco menor e metade das luminárias apagadas;
 *   alerta    piscadas curtas e aleatórias por sala (`flicker`: seed
 *             determinística, no máximo 2 por FLICKER_SLOT_S);
 *   apagão    quase escuro, luar pelas janelas, monitores pretos, emergência e
 *             SAÍDA. Entra zona a zona com tremida (`roomLight` 'out', ~1,5 s)
 *             e volta zona a zona (`roomLight` 'back', ~2 s).
 * No LONGE, a zona no escuro fica só com o escurecimento e a emergência.
 */
import { Color, type AmbientLight, type DirectionalLight, type HemisphereLight } from 'three'
import type { PowerLevel } from './power'

/** Duração da queda (todas as salas) e da volta da luz. */
export const LIGHTS_OUT_S = 1.5
export const LIGHTS_BACK_S = 2
/** Quanto cada sala treme antes de apagar / ao acender. */
const OUT_FLICKER_S = 0.6
const BACK_FLICKER_S = 0.8
/** Piscadas do alerta: no máximo 2 por fatia. */
export const FLICKER_SLOT_S = 1.6

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
