/**
 * Ossos do avatar GLB — PURO (sem three): o nome de cada junta que o adaptador
 * (agentAvatar.ts) move, no padrão do Mixamo (mixamorig:Hips, Spine, Spine1,
 * Spine2, LeftHandIndex1…) e no do Meshy (Hips → Spine02 → Spine01 → Spine →
 * neck, sem dedos). O GLTFLoader tira o ":" dos nomes (mixamorigHips) e o
 * Mixamo às vezes numera o prefixo (mixamorig1:): tudo isso cai fora antes de
 * comparar, em minúsculas.
 */

export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const
export type Finger = (typeof FINGERS)[number]
export type Side = 'L' | 'R'

export type AvatarJoint =
  | 'hips' | 'spine0' | 'spine1' | 'spine2' | 'neck' | 'head' | 'headTop'
  | `shoulder${Side}` | `arm${Side}` | `forearm${Side}` | `hand${Side}`
  | `upLeg${Side}` | `leg${Side}` | `foot${Side}` | `toe${Side}` | `toeEnd${Side}`
  | `${Lowercase<Finger>}${1 | 2 | 3}${Side}`

export type RigFlavor = 'mixamo' | 'meshy'

/** Sem estas o avatar não anda nem senta: o modelo é recusado (fica o boneco). */
export const REQUIRED: readonly AvatarJoint[] = [
  'hips', 'spine0', 'spine2', 'head', 'armL', 'forearmL', 'handL', 'armR', 'forearmR', 'handR',
  'upLegL', 'legL', 'footL', 'upLegR', 'legR', 'footR'
]

/** Nome normalizado: sem o prefixo do Mixamo (com ou sem número e ":"/"_") e em minúsculas. */
export function normBone(name: string): string {
  return name.replace(/^mixamorig\d*[:_]?/i, '').toLowerCase()
}

const SIDES: Record<Side, string> = { L: 'left', R: 'right' }

function table(flavor: RigFlavor): Map<string, AvatarJoint> {
  const t = new Map<string, AvatarJoint>()
  const spine = flavor === 'mixamo' ? ['spine', 'spine1', 'spine2'] : ['spine02', 'spine01', 'spine']
  t.set('hips', 'hips')
  spine.forEach((n, i) => t.set(n, `spine${i}` as AvatarJoint))
  t.set('neck', 'neck')
  t.set('head', 'head')
  t.set(flavor === 'mixamo' ? 'headtop_end' : 'head_end', 'headTop')
  for (const s of ['L', 'R'] as const) {
    const p = SIDES[s]
    t.set(`${p}shoulder`, `shoulder${s}`)
    t.set(`${p}arm`, `arm${s}`)
    t.set(`${p}forearm`, `forearm${s}`)
    t.set(`${p}hand`, `hand${s}`)
    t.set(`${p}upleg`, `upLeg${s}`)
    t.set(`${p}leg`, `leg${s}`)
    t.set(`${p}foot`, `foot${s}`)
    t.set(`${p}toebase`, `toe${s}`)
    t.set(`${p}toe_end`, `toeEnd${s}`)
    for (const f of FINGERS) for (const k of [1, 2, 3] as const) t.set(`${p}hand${f.toLowerCase()}${k}`, `${f.toLowerCase()}${k}${s}` as AvatarJoint)
  }
  return t
}

const TABLES: Record<RigFlavor, Map<string, AvatarJoint>> = { mixamo: table('mixamo'), meshy: table('meshy') }

/** O padrão do esqueleto: o Meshy tem Spine02 (e o "Spine" dele é o de cima); o resto é Mixamo. */
export function rigFlavor(names: readonly string[]): RigFlavor {
  return names.some((n) => normBone(n) === 'spine02') ? 'meshy' : 'mixamo'
}

export interface BoneMap {
  flavor: RigFlavor
  /** Junta → nome original do osso no modelo. */
  bones: Partial<Record<AvatarJoint, string>>
  /** Juntas obrigatórias que faltaram (vazio = o modelo serve). */
  missing: AvatarJoint[]
  /** Tem os dedos (indicador e polegar das duas mãos). */
  fingers: boolean
}

/** Liga os nomes dos ossos do modelo às juntas do adaptador. */
export function mapBones(names: readonly string[]): BoneMap {
  const flavor = rigFlavor(names)
  const t = TABLES[flavor]
  const bones: Partial<Record<AvatarJoint, string>> = {}
  for (const n of names) {
    const j = t.get(normBone(n))
    if (j && !bones[j]) bones[j] = n
  }
  const missing = REQUIRED.filter((j) => !bones[j])
  const fingers = (['index1L', 'thumb1L', 'index1R', 'thumb1R'] as const).every((j) => !!bones[j])
  return { flavor, bones, missing, fingers }
}
