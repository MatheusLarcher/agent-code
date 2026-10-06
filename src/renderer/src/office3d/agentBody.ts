/**
 * O corpo que um personagem mostra: o boneco procedural (rig.ts) ou o avatar
 * GLB (agentAvatar.ts), conforme agentModels.ts. O boneco é sempre montado e
 * posado (a pose, o clique e a sombra saem dele); com o avatar ele só fica
 * escondido e o avatar copia a pose. Aqui ficam as trocas e o que muda com o
 * corpo: medidas (BODY ou as do modelo), a mão que segura o objeto (com o
 * encaixe de cada um), o centro da cabeça, a sombra do LOD e o brilho do monitor.
 */
import type { Group, Object3D, Vector3 } from 'three'
import { AvatarBody } from './agentAvatar'
import type { AgentModels } from './agentModels'
import type { AvatarTemplate } from './agentRest'
import { seedColor } from './appearance'
import type { PropKind } from './brain'
import { BODY, type BodyMetrics, type Pose } from './poses'
import { GRIP, GRIP_AVATAR, HOLD_CURL } from './props'
import type { Rig } from './rig'

export class CharacterBody {
  avatar: AvatarBody | null = null
  private template: AvatarTemplate | null = null
  private version = -1
  /** Trocou de corpo e a sombra ainda não foi refeita. */
  private castDirty = false

  constructor(
    private readonly models: AgentModels | null,
    private readonly rig: Rig,
    private readonly group: Group,
    private readonly role: string,
    private readonly seed: string,
    private readonly key: string,
    /** Modelo próprio deste personagem (a Central: o avatar do usuário); null = o do papel. */
    private readonly own: string | null = null
  ) {}

  /** Medidas do corpo à mostra (as poses e o HUD usam). */
  get metrics(): BodyMetrics {
    return this.avatar?.metrics ?? BODY
  }

  /**
   * Troca de corpo se o modelo do papel mudou (chave de teste, GLB pronto); true
   * se trocou (o quadro tem de posar já: nada aparece na pose de repouso). Os
   * objetos vão para a mão nova e o avatar entra no nível `lod`.
   */
  sync(props: Map<PropKind, Group>, lod: number): boolean {
    if (!this.models || this.version === this.models.version) return false
    const t = this.models.modelFor(this.role, this.own)
    // Poucos por quadro (agentModels.claim): quem não teve vez tenta no próximo.
    if (t && t !== this.template && !this.models.claim()) return false
    this.version = this.models.version
    if (t === this.template) return false
    this.avatar?.dispose()
    this.avatar = null
    this.template = t
    if (t) {
      this.avatar = new AvatarBody(t, seedColor(this.seed), this.models.envMap(), this.key)
      this.group.add(this.avatar.root)
    }
    this.rig.pelvis.visible = !this.avatar
    for (const [kind, p] of props) this.hold(kind, p)
    this.avatar?.setLod(lod)
    this.castDirty = true
    return true
  }

  /** Põe o objeto na mão direita do corpo atual, no encaixe dele. */
  hold(kind: PropKind, p: Group): void {
    const g = this.avatar ? GRIP_AVATAR[kind] : GRIP[kind]
    ;(this.avatar?.socketR ?? this.rig.handR).add(p)
    p.position.set(g[0], g[1], g[2])
  }

  /** Depois do applyPose: o avatar copia a pose (sentado à mesa, sem objeto, as palmas descem). */
  pose(p: Pose, desk: boolean, prop: PropKind | null, dt: number): void {
    this.avatar?.apply(this.rig, p, desk && !prop ? 1 : 0, prop ? HOLD_CURL[prop] : 0, dt)
  }

  /** A troca de corpo ainda não refez a sombra? (zera ao ler) */
  takeCast(): boolean {
    const d = this.castDirty
    this.castDirty = false
    return d
  }

  /** Centro da cabeça no mundo. */
  headPoint(out: Vector3): Vector3 {
    return (this.avatar?.headCenter ?? (this.rig.headMesh as Object3D)).getWorldPosition(out)
  }

  setLod(level: number): void {
    this.avatar?.setLod(level)
  }

  setGlow(color: number, intensity: number): void {
    this.avatar?.setGlow(color, intensity)
  }

  dispose(): void {
    this.avatar?.dispose()
    this.avatar = null
  }
}
