/**
 * O corpo que um personagem mostra: o boneco procedural (rig.ts) ou o avatar
 * GLB (agentAvatar.ts), conforme agentModels.ts. O boneco é sempre montado e
 * posado (a pose, o clique e a sombra saem dele); com o avatar ele só fica
 * escondido e o avatar copia a pose. Aqui ficam as trocas e o que muda com o
 * corpo: medidas (BODY ou as do modelo), a mão que segura o objeto (com o
 * encaixe de cada um), o centro da cabeça e a sombra do LOD.
 */
import type { Color, Group, MeshLambertMaterial, Object3D, Vector3 } from 'three'
import { AvatarBody } from './agentAvatar'
import type { AgentModels } from './agentModels'
import type { AvatarTemplate } from './agentRest'
import type { TintUniforms } from './agentTint'
import { shirtHex, type ProjectColorFeed } from './projectColor'
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
    private readonly own: string | null = null,
    /** A camisa do boneco (characters.ts `shirtMat`): troca de cor junto com o avatar. */
    private readonly shirt: MeshLambertMaterial | null = null
  ) {
    this.tint = seedColor(seed)
  }

  /** A cor da roupa (linear): a do projeto (setShirtColor) ou, sem projeto, a da seed. */
  private readonly tint: Color
  private tintHex: string | null = null

  /**
   * A camisa na cor do projeto (`#rrggbb`; null = sem projeto, a cor da seed — a
   * Central). Troca em cena, sem recriar o corpo: a cor do boneco e o uniform
   * `tintColor` do avatar (agentTint.ts); o avatar que nascer depois já sai nela.
   * true se mudou.
   */
  setShirtColor(hex: string | null): boolean {
    if (hex === this.tintHex) return false
    this.tintHex = hex
    if (hex) this.tint.set(hex)
    else this.tint.copy(seedColor(this.seed))
    this.shirt?.color.copy(this.tint)
    ;(this.avatar?.material.userData.tint as TintUniforms | undefined)?.tintColor.value.copy(this.tint)
    return true
  }

  /** A camisa pelo projeto do personagem (office3d/projectColor.ts: a do feed, senão a reserva); sem projeto, a da seed. */
  paintShirt(feed: ProjectColorFeed, projectId: string | null): boolean {
    return this.setShirtColor(shirtHex(feed, projectId))
  }

  /** Medidas do corpo à mostra (as poses e o HUD usam). */
  get metrics(): BodyMetrics {
    return this.avatar?.metrics ?? BODY
  }

  /**
   * Escala do personagem: com o avatar, a que deixa o modelo na altura da ficha (agentRest.ts `fit`);
   * com o boneco, a do papel (o principal inteiro, os demais 0,85). O grupo acompanha a cada troca.
   */
  get scale(): number {
    return this.template?.fit ?? (this.role === 'principal' ? 1 : 0.85)
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
      this.avatar = new AvatarBody(t, this.tint, this.models.envMap(), this.key)
      this.group.add(this.avatar.root)
    }
    this.rig.pelvis.visible = !this.avatar
    this.group.scale.setScalar(this.scale)
    for (const [kind, p] of props) this.hold(kind, p)
    this.avatar?.setLod(lod)
    this.castDirty = true
    return true
  }

  /** Põe o objeto na mão direita do corpo atual, no encaixe dele (guardado em userData.grip: a xícara se pendura por ele, props.holdCup). */
  hold(kind: PropKind, p: Group): void {
    const g = this.avatar ? GRIP_AVATAR[kind] : GRIP[kind]
    ;(this.avatar?.socketR ?? this.rig.handR).add(p)
    p.position.set(g[0], g[1], g[2])
    p.userData.grip = g
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

  dispose(): void {
    this.avatar?.dispose()
    this.avatar = null
  }
}
