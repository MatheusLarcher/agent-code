/**
 * Culling e LOD de UMA sala do Escritório 3D (three). A caixa da sala (mundo)
 * serve ao frustum e à distância; as listas do que esconder por nível saem das
 * marcas que decor.ts põe (userData.lod = 'detail' some no MÉDIO, 'small' no
 * LONGE) e são montadas UMA vez, na criação da sala — trocar de nível só
 * percorre as listas, nada atravessa o grafo por quadro.
 *
 * Sombra no MÉDIO só dos móveis grandes: o que está sob uma marca e projeta
 * sombra (vaso, poste da luminária, máquina de café, pé da cadeira…) deixa de
 * projetar fora do PERTO.
 */
import { Box3, Mesh, Vector3, type Object3D } from 'three'
import type { Lod } from './lod'

export type LodTag = 'detail' | 'small'

/** Marca `o` para o LOD da sala (decor.ts). */
export function tagLod<T extends Object3D>(o: T, tag: LodTag): T {
  o.userData.lod = tag
  return o
}

export interface RoomLod {
  /** Caixa da sala no mundo, com folga para a porta, a placa e quem está em pé. */
  readonly box: Box3
  readonly detail: readonly Object3D[]
  readonly small: readonly Object3D[]
  /** Projetam sombra só no PERTO. */
  readonly smallCasters: readonly Mesh[]
  level: Lod
  /** Fora do frustum: grupo invisível e nada da sala é processado. */
  culled: boolean
  /** false até a 1ª câmera: o 1º nível sai sem histerese. */
  placed: boolean
}

/** Folgas da caixa: a porta (−X) recebe quem chega e sai; em cima cabem cabeça, bateria e "!". */
const DOOR_SIDE = 1.6
const EDGE = 0.2
const TOP = 2.4

export function roomBox(x: number, z: number, width: number, depth: number): Box3 {
  return new Box3(new Vector3(x - DOOR_SIDE, 0, z - EDGE), new Vector3(x + width + EDGE, TOP, z + depth + EDGE))
}

const tagged = (o: Object3D, root: Object3D): boolean => {
  for (let p: Object3D | null = o; p && p !== root; p = p.parent) if (p.userData.lod) return true
  return false
}

export function collectRoomLod(group: Object3D, box: Box3): RoomLod {
  const detail: Object3D[] = []
  const small: Object3D[] = []
  const smallCasters: Mesh[] = []
  group.traverse((o) => {
    if (o.userData.lod === 'detail') detail.push(o)
    else if (o.userData.lod === 'small') small.push(o)
    if (o instanceof Mesh && o.castShadow && tagged(o, group)) smallCasters.push(o)
  })
  return { box, detail, small, smallCasters, level: 0, culled: false, placed: false }
}

/** Aplica o nível às malhas marcadas; true se mudou. */
export function setRoomLevel(r: RoomLod, level: Lod): boolean {
  if (r.level === level) return false
  r.level = level
  for (const o of r.detail) o.visible = level === 0
  for (const o of r.small) o.visible = level < 2
  for (const m of r.smallCasters) m.castShadow = level === 0
  return true
}
