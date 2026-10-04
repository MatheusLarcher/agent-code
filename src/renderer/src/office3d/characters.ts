/**
 * Personagens do escritório 3D: o corpo articulado (rig.ts) animado pelo
 * cérebro (brain.ts) com a biblioteca de poses (poses.ts). Camisa, cabelo,
 * pele e calça saem da seed (appearance.ts; estáveis por conversa/trilha).
 *
 * `update(dt, lod)` por quadro: posição/rumo do cérebro, fase da caminhada
 * pela DISTÂNCIA andada (pé não desliza), sentar/levantar pelo peso `sit`,
 * crossfade de BLEND_S entre ações, reação por cima, cabeça olhando o alvo
 * (monitor, colega, câmera; `glance` passa por cima por GLANCE_S — a tela do
 * projetor que acendeu), piscar a cada 3–6 s, respiração, objeto na mão e
 * efeitos (confete, fumaça, suor, vapor, gotas, "!"). lod 0 = completo; 1 =
 * sem crossfade/piscar/respirar/vapor, sem os detalhes (olhos, dedos, objetos
 * de mão — só a plaquinha "Posso?" e a lanterna da festa ficam) e sem sombra;
 * 2 = pose a ~10 Hz, sem efeito, sem objeto de mão nem mãos/pescoço/sapatos.
 * A cena tira de cena quem está numa sala fora da tela (`setView`): sem update
 * nenhum; ao voltar, o 1º update mostra o estado atual direto (sem crossfade,
 * olhar atrasado nem efeito velho). `castMoved()` diz se a sombra dele mudou.
 * Na festa do apagão os passos seguem a batida do relógio da cena (dance.ts):
 * todos dançam juntos, com os joelhos no ritmo.
 * Nada aloca no caminho quente: poses em Float32Array e vetores de rascunho.
 *
 * Acima da cabeça (HUD que acompanha a cabeça): indicador (permissão/pergunta/
 * erro…), os "z" do cochilo e o "!" do pedido. A bateria agora é do escritório
 * (power.ts); o contexto de cada agente é a pilha de papéis na mesa dele
 * (paperPile.ts).
 */
import { Group, Mesh, MeshLambertMaterial, Sprite, Vector3 } from 'three'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { appearance, HAIR, seedColor, SKIN } from './appearance'
import { brainBusy, FX, type Brain, type PropKind } from './brain'
import { beatAt, danceLower, isDance } from './dance'
import type { Kit } from './kit'
import type { CharacterLayout } from './layout'
import { actionPose, reactionPose } from './gestures'
import { FAR_POSE_S, type Lod } from './lod'
import type { Particles } from './particles'
import {
  BLEND_S,
  CH,
  clamp01,
  lerpPose,
  locomotion,
  newPose,
  REACTION_S,
  sitLower,
  smooth,
  standPose,
  strideLength,
  UPPER,
  type Action,
  type ActionParams
} from './poses'
import { GRIP, makeProp, PROP_PITCH, type PropKit } from './props'
import { applyPose, buildRig, headLocal, type Rig } from './rig'

const GLOW = 0x6fa2ff
const LOWER: readonly number[] = [CH.pelvisY, CH.pelvisZ, CH.legL, CH.kneeL, CH.legR, CH.kneeR, CH.footL, CH.footR]
/** Quanto dura a olhada para a tela do projetor que acendeu (s). */
export const GLANCE_S = 4

export type { Lod } from './lod'
export { appearance, seedColor, type Appearance } from './appearance'

/** Contexto do quadro, um só para todos (a cena preenche antes dos updates). */
export interface FrameCtx {
  /** Relógio (s). */
  t: number
  camX: number
  camY: number
  camZ: number
  particles: Particles | null
}

const scratch = new Vector3()
const head = { x: 0, y: 0, z: 0 }

export class Character3D {
  readonly key: string
  readonly group = new Group()
  readonly rig: Rig
  model: OfficeCharacterModel
  readonly skinMat: MeshLambertMaterial
  readonly shirtMat: MeshLambertMaterial
  readonly hairMat: MeshLambertMaterial
  /** Escondido pelo foco no monitor (a cena decide). */
  focusHidden = false
  /** Sala fora da tela: invisível e sem update (a cena decide em setView). */
  culled = false
  /** Nível pela distância (a cena passa no update). */
  viewLevel: Lod = 0
  /** Já recebeu um nível (o 1º sai sem histerese). */
  viewPlaced = false
  /** A sala dele está sem luz (apagão): o monitor apagou, o rosto não brilha. */
  powerDark = false
  /** A mesa dele (a cadeira que recua quando ele senta/levanta) e quanto ela está recuada agora. */
  deskIndex: number | null = null
  chairPull = 0
  private readonly scale: number
  /** Nível aplicado ao visual (detalhes, partes pequenas, sombra). */
  private shown: Lod = 0
  /** Próximo update vira a cabeça direto para o alvo (voltou à vista). */
  private lookSnap = false
  /** O que a sombra dele era na última vez que contou como mudança. */
  private readonly castAt = { vis: false, x: NaN, z: NaN, yaw: NaN, py: NaN, lean: NaN }
  private readonly hud = new Group()
  private indicator: Mesh | null = null
  private bubble: OfficeCharacterModel['bubble'] = null
  private readonly zs: Sprite[]
  private bang: Sprite | null = null
  private bangT = -1
  private readonly props = new Map<PropKind, Group>()
  private propKind: PropKind | null = null
  private readonly lower = newPose()
  private readonly sitPose = newPose()
  private readonly upper = newPose()
  private readonly from = newPose()
  private readonly out = newPose()
  private readonly react = newPose()
  private readonly params: ActionParams
  private phase = 0
  private blendT = BLEND_S
  private lastAction: Action | null = null
  private lookW = 0
  private lookYaw = 0
  private lookPitch = 0
  /** Olhada por cima do olhar do cérebro (a tela do projetor que acendeu) até `ctx.t` chegar em `glanceUntil`. */
  private readonly glanceAt = { x: 0, y: 0, z: 0 }
  private glanceUntil = -1
  private nextBlink: number
  private blinkT = 1
  private steamT = 0
  private smokeLeft = 0
  private smokeT = 0
  private lodT = 0
  private screenOn = false

  constructor(
    private readonly kit: Kit,
    private readonly propKit: PropKit,
    private readonly ctx: FrameCtx,
    c: CharacterLayout,
    readonly brain: Brain
  ) {
    this.key = c.key
    this.model = c.model
    const a = appearance(c.model.seed)
    this.skinMat = new MeshLambertMaterial({ color: SKIN[a.skin], emissive: GLOW, emissiveIntensity: 0 })
    this.shirtMat = new MeshLambertMaterial({ color: seedColor(c.model.seed) })
    this.hairMat = new MeshLambertMaterial({ color: HAIR[a.hair] })
    this.rig = buildRig(kit, this.group, { skin: this.skinMat, shirt: this.shirtMat, hair: this.hairMat, pants: kit.mat.pants[a.pants] })
    this.group.add(this.hud)
    this.zs = [0.1, 0.13, 0.16].map((s) => {
      const z = new Sprite(kit.mat.z)
      z.scale.setScalar(s)
      z.visible = false
      this.hud.add(z)
      return z
    })

    this.scale = c.model.role === 'principal' ? 1 : 0.85
    this.group.scale.setScalar(this.scale)
    this.params = { speed: 1, seed: brain.seed, side: brain.side }
    this.nextBlink = 1 + (brain.seed % 3)
    this.group.traverse((o) => {
      if (o instanceof Mesh) o.userData.charKey = this.key
    })
    this.update(0, 0)
  }

  /** Modelo novo: indicador e se o monitor dele está aceso. */
  applyModel(c: CharacterLayout, screenOn: boolean): void {
    this.model = c.model
    this.setBubble(c.model.bubble)
    if (this.indicator) this.indicator.position.y = 0.38
    this.screenOn = screenOn && c.model.active
  }

  private setBubble(bubble: OfficeCharacterModel['bubble']): void {
    if (this.bubble === bubble) return
    if (this.indicator) this.hud.remove(this.indicator)
    this.indicator = null
    this.bubble = bubble
    if (!bubble) return
    const ind = new Mesh(bubble === 'permissao' ? this.kit.geo.alert : this.kit.geo.bubble, this.kit.mat.bubbles[bubble])
    ind.userData.charKey = this.key
    this.hud.add(ind)
    this.indicator = ind
  }

  /** Vira a cabeça para (x, y, z) por `seconds` — a tela do projetor que acendeu na sala. */
  glance(x: number, y: number, z: number, seconds = GLANCE_S): void {
    this.glanceAt.x = x
    this.glanceAt.y = y
    this.glanceAt.z = z
    this.glanceUntil = this.ctx.t + seconds
  }

  /** Culling/LOD vindos da cena. Voltar à vista sincroniza no próximo update, sem animar o atraso. */
  setView(culled: boolean, level: Lod): void {
    if (this.culled && !culled) this.snap()
    this.culled = culled
    this.viewLevel = level
    this.viewPlaced = true
    if (culled) this.group.visible = false
  }

  /** O que aconteceu fora da tela não anima: sem crossfade, sem efeito pendente, olhar e pose já no lugar. */
  private snap(): void {
    this.brain.fx = 0
    this.blendT = BLEND_S
    this.lastAction = this.brain.action
    this.lookSnap = true
    this.lodT = 0
    this.smokeLeft = 0
    this.bangT = -1
    if (this.bang) this.bang.visible = false
  }

  /** Visual do nível: detalhes só PERTO; mãos, pescoço e sapatos fora do LONGE; sombra só PERTO. */
  private applyLod(level: Lod): void {
    this.shown = level
    for (const m of this.rig.details) m.visible = level === 0
    for (const m of this.rig.smalls) m.visible = level < 2
    this.rig.torso.castShadow = level === 0
    this.rig.headMesh.castShadow = level === 0
  }

  /** A sombra dele mudou (andou, sentou, apareceu/sumiu, deixou de projetar) desde a última vez que contou? */
  castMoved(): boolean {
    const a = this.castAt
    const vis = this.group.visible && this.shown === 0
    if (!vis && !a.vis) return false
    const g = this.group
    const py = this.rig.pelvis.position.y
    const lean = this.rig.spine.rotation.x
    const same =
      vis === a.vis &&
      Math.abs(g.position.x - a.x) < 0.01 &&
      Math.abs(g.position.z - a.z) < 0.01 &&
      Math.abs(g.rotation.y - a.yaw) < 0.02 &&
      Math.abs(py - a.py) < 0.01 &&
      Math.abs(lean - a.lean) < 0.02
    if (same) return false
    a.vis = vis
    a.x = g.position.x
    a.z = g.position.z
    a.yaw = g.rotation.y
    a.py = py
    a.lean = lean
    return true
  }

  /** Um quadro: devolve true se este personagem ainda precisa de quadros. */
  update(dt: number, lod: Lod): boolean {
    const b = this.brain
    if (lod !== this.shown) this.applyLod(lod)
    this.group.visible = b.visible && !this.focusHidden && !this.culled
    if (!b.visible) {
      b.fx = 0
      this.bangT = -1
      return false
    }
    this.group.position.set(b.x, 0, b.z)
    this.group.rotation.y = b.yaw
    const run = clamp01((b.speed - 1.3) / 1.4)
    this.phase = (this.phase + (b.speed * dt) / (strideLength(run) * this.scale)) % 1
    let posed = true
    if (lod === 2) {
      this.lodT -= dt
      posed = this.lodT <= 0
      if (posed) this.lodT = FAR_POSE_S
    }
    if (posed) {
      this.pose(dt, lod, run)
      applyPose(this.rig, this.out, lod === 0 ? this.blink(dt) : 1, lod === 0 ? Math.sin(this.ctx.t * 1.75 + b.seed) : 0)
    }
    this.placeProp(dt, lod)
    this.placeHud(dt)
    this.effects(dt, lod)
    const t = this.ctx.t
    const glow = this.screenOn && !this.powerDark && b.mode === 'work' && b.sit > 0.9
    this.skinMat.emissiveIntensity = glow ? 0.2 + Math.sin(t * 7.3) * 0.03 + Math.sin(t * 2.1) * 0.03 : 0
    if (this.indicator) {
      this.indicator.scale.setScalar(1 + Math.sin(t * 3) * 0.12)
      this.indicator.rotation.y = t * 1.2
    }
    return brainBusy(b) || this.blendT < BLEND_S || this.bangT >= 0 || this.smokeLeft > 0 || this.indicator !== null || t < this.glanceUntil
  }

  private pose(dt: number, lod: Lod, run: number): void {
    const b = this.brain
    locomotion(this.lower, this.phase, smooth(b.speed / 0.35), run)
    if (b.sit > 0) {
      this.sitPose.set(this.lower)
      sitLower(this.sitPose, b.seat ?? 'chair', this.ctx.t)
      lerpPose(this.lower, this.lower, this.sitPose, smooth(b.sit), LOWER)
    }
    this.params.speed = b.workSpeed
    this.params.seated = b.sit > 0.5 && b.seat === 'chair'
    const beat = beatAt(this.ctx.t)
    this.params.beat = beat
    if (b.action !== this.lastAction) {
      this.from.set(this.out)
      this.blendT = lod === 0 && this.lastAction !== null ? 0 : BLEND_S
      this.lastAction = b.action
    }
    if (b.action === 'none') this.upper.set(this.lower)
    else standPose(this.upper)
    actionPose(this.upper, b.action, b.actionT, this.params)
    this.blendT += dt
    this.out.set(this.lower)
    lerpPose(this.out, this.from, this.upper, smooth(this.blendT / BLEND_S), UPPER)
    // Dançando parado em pé: os joelhos entram no ritmo.
    if ((isDance(b.action) || b.action === 'conga') && b.sit === 0 && b.speed < 0.05) danceLower(this.out, b.action, beat)
    if (b.reaction) {
      this.react.set(this.out)
      reactionPose(this.react, b.reaction, b.reactionT, this.params, b.sit > 0.5)
      const dur = REACTION_S[b.reaction]
      const w = smooth(b.reactionT / 0.15) * (1 - smooth((b.reactionT - (dur - 0.2)) / 0.2))
      lerpPose(this.out, this.out, this.react, w, UPPER)
    }
    this.lookAt(dt, lod)
  }

  /** A cabeça vira para o alvo (monitor, colega, câmera) dentro dos limites do pescoço. */
  private lookAt(dt: number, lod: Lod): void {
    const b = this.brain
    const ctx = this.ctx
    const greet = b.reaction === 'greet'
    const glance = ctx.t < this.glanceUntil && !greet
    const g = this.glanceAt
    let want = 0
    let yaw = 0
    let pitch = 0
    if (b.look !== 'none' || greet || glance) {
      const cam = !glance && (b.look === 'camera' || greet)
      const dx = (glance ? g.x : cam ? ctx.camX : b.lookX) - b.x
      const dz = (glance ? g.z : cam ? ctx.camZ : b.lookZ) - b.z
      const c = Math.cos(b.yaw)
      const s = Math.sin(b.yaw)
      const lx = dx * c - dz * s
      const lz = dx * s + dz * c
      yaw = Math.atan2(-lx, -lz)
      headLocal(this.out, head)
      pitch = -Math.atan2((glance ? g.y : cam ? ctx.camY : b.lookY) - head.y * this.scale, Math.max(0.05, Math.hypot(lx, lz)))
      if (Math.abs(yaw) < 2.3) want = 1
      yaw = Math.max(-1.2, Math.min(1.2, yaw))
      pitch = Math.max(-0.7, Math.min(0.7, pitch))
    }
    const k = lod === 0 && !this.lookSnap ? Math.min(1, dt * 7) : 1
    this.lookSnap = false
    this.lookW += (want - this.lookW) * k
    if (want) {
      this.lookYaw += (yaw - this.lookYaw) * k
      this.lookPitch += (pitch - this.lookPitch) * k
    }
    if (this.lookW < 0.001) return
    const o = this.out
    o[CH.headYaw] += (this.lookYaw - o[CH.twist] - o[CH.headYaw]) * this.lookW
    o[CH.headPitch] += (this.lookPitch - o[CH.lean] - o[CH.headPitch]) * this.lookW
  }

  /** Pisca a cada 3–6 s (fecha e abre em ~0,16 s). */
  private blink(dt: number): number {
    const t = this.ctx.t
    if (t >= this.nextBlink) {
      this.blinkT = 0
      this.nextBlink = t + 3 + 3 * ((Math.sin(t * 12.9898 + this.brain.seed) * 43758.5453) % 1 + 1) / 2
    }
    if (this.blinkT >= 0.16) return 1
    this.blinkT += dt
    return 1 - Math.sin((Math.PI * Math.min(this.blinkT, 0.16)) / 0.16)
  }

  /** Objeto na mão direita, endireitado contra a inclinação do braço. MÉDIO: só a plaquinha; LONGE: nenhum. */
  private placeProp(dt: number, lod: Lod): void {
    const b = this.brain
    const kind: PropKind | null = b.reaction === 'handoff' ? 'folder' : b.prop
    if (kind !== this.propKind) {
      if (this.propKind) this.props.get(this.propKind)!.visible = false
      if (kind && !this.props.has(kind)) {
        const p = makeProp(this.propKit, kind)
        p.position.set(GRIP[kind][0], GRIP[kind][1], GRIP[kind][2])
        this.rig.handR.add(p)
        this.props.set(kind, p)
      }
      this.propKind = kind
    }
    if (!kind) return
    const p = this.props.get(kind)!
    // MÉDIO: só o que é informação (a plaquinha) ou efeito da festa (a lanterna).
    p.visible = lod === 0 || (lod === 1 && (kind === 'sign' || kind === 'flashlight'))
    if (!p.visible) return
    const o = this.out
    const tilt = kind === 'cup' ? 0.9 * o[CH.prop] : kind === 'can' ? -o[CH.prop] : 0
    p.rotation.x = o[CH.lean] - o[CH.armFwdR] - o[CH.elbowR] + PROP_PITCH[kind] + tilt
    const parts = this.ctx.particles
    if (kind !== 'cup' || lod !== 0 || !parts) return
    this.steamT -= dt
    if (this.steamT > 0) return
    this.steamT = 0.32
    p.getWorldPosition(scratch)
    parts.puff('steam', scratch.x, scratch.y + 0.11 * this.scale, scratch.z)
  }

  private placeHud(dt: number): void {
    const b = this.brain
    headLocal(this.out, head)
    this.hud.position.set(head.x, head.y, head.z)
    const t = this.ctx.t
    for (let i = 0; i < this.zs.length; i++) {
      const z = this.zs[i]
      z.visible = b.zzz
      if (!b.zzz) continue
      const f = (t * 0.35 + i / 3) % 1
      z.position.set(0.14 + f * 0.3, 0.1 + f * 0.42, 0)
    }
    if (this.bangT < 0 || !this.bang) return
    this.bangT += dt
    const k = this.bangT
    if (k > 1.1) {
      this.bang.visible = false
      this.bangT = -1
      return
    }
    // Salta com sobressinal, sobe um pouco e some.
    const pop = k < 0.18 ? (k / 0.18) * 1.25 : k < 0.3 ? 1.25 - ((k - 0.18) / 0.12) * 0.25 : 1
    const fade = k > 0.85 ? Math.max(0, 1 - (k - 0.85) / 0.25) : 1
    this.bang.scale.setScalar(0.3 * pop * fade)
    // Acima do indicador, subindo um pouco.
    this.bang.position.set(0, 0.55 + 0.2 * Math.min(1, k * 2.5), 0)
  }

  private effects(dt: number, lod: Lod): void {
    const b = this.brain
    const parts = this.ctx.particles
    const fx = b.fx
    b.fx = 0
    if (fx & FX.bang) {
      if (!this.bang) {
        this.bang = new Sprite(this.propKit.mat.bang)
        this.hud.add(this.bang)
      }
      this.bang.visible = true
      this.bangT = 0
    }
    if (fx & FX.smoke) {
      this.smokeLeft = 4
      this.smokeT = 0
    }
    if (!parts || lod === 2) return
    if ((fx & (FX.confetti | FX.sweat)) !== 0 || this.smokeLeft > 0) this.rig.headMesh.getWorldPosition(scratch)
    const rx = Math.cos(b.yaw)
    const rz = -Math.sin(b.yaw)
    if (fx & FX.confetti) parts.confettiBurst(scratch.x, scratch.y + 0.35, scratch.z)
    if (fx & FX.sweat) parts.puff('sweat', scratch.x + rx * 0.12, scratch.y + 0.08, scratch.z + rz * 0.12, rx * 0.35, rz * 0.35)
    if (this.smokeLeft > 0) {
      this.smokeT -= dt
      if (this.smokeT <= 0) {
        this.smokeT = 0.18
        this.smokeLeft--
        parts.puff('smoke', scratch.x, scratch.y + 0.22, scratch.z)
      }
    }
    if (fx & FX.drops) {
      const can = this.props.get('can')
      if (can?.visible) {
        can.getWorldPosition(scratch)
        const fwdX = -Math.sin(b.yaw)
        const fwdZ = -Math.cos(b.yaw)
        parts.puff('drop', scratch.x + fwdX * 0.2, scratch.y + 0.08, scratch.z + fwdZ * 0.2, fwdX * 0.3, fwdZ * 0.3)
      }
    }
  }

  /** Centro da cabeça no mundo (para balões de fala); false se não está à vista. */
  headWorldPosition(out: Vector3): boolean {
    if (!this.brain.visible) return false
    this.rig.headMesh.getWorldPosition(out)
    return true
  }

  dispose(): void {
    this.group.removeFromParent()
    // O rosto é instanciado: os buffers das instâncias são deste boneco.
    this.rig.face.dispose()
    this.rig.brows.dispose()
    this.skinMat.dispose()
    this.shirtMat.dispose()
    this.hairMat.dispose()
  }
}
