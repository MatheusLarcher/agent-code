/**
 * Balões de fala do Escritório 3D: liga o gerador (quips/generator) à camada
 * DOM (quips/bubbleLayer) e decide, a cada quadro, quais aparecem e onde.
 *
 *   feed(snapshot, events, now, power?)  a cada feed: o retrato e os eventos de
 *                                   events.ts (`now` = o mesmo do snapshotOf) e
 *                                   a energia do escritório (anúncios, festa);
 *   tick(now, power?)               ~4×/s sem feed (TTL e ociosos andam com o
 *                                   relógio). Os dois devolvem true se algum
 *                                   balão mudou — o motor agenda um quadro;
 *   place(camera, w, h, far, head)  a cada quadro, depois do render.
 *
 * Escolha: no máximo MAX_BUBBLES à vista, pela prioridade da fala e depois pela
 * proximidade da câmera (quem já está à vista, ou na cabeça, leva uma folga, para
 * não trocar à toa). Lugar: nessa mesma ordem, bubbleLayout.ts tira as sobreposições em tela
 * — quem cobriria um balão já posto sobe (até 2 andares, com uma linha-guia até
 * a cabeça) ou vira ícone compacto; sem lugar nem para o ícone, não aparece.
 * Nenhum passa da barra do HUD (BUBBLE_TOP): o da cabeça desce até caber abaixo
 * dela, com a ponta no x da cabeça; se nem assim cabe sem a ponta entrar na
 * cabeça, vira para baixo dela, com a ponta para cima.
 * Tamanho: a camada mede o balão quando a fala muda (nunca por quadro); a escala
 * vem da distância da cabeça (bubbleScale: 1 perto, 0,8 no médio, fonte nunca
 * abaixo de MIN_FONT_PX). Zoom LONGE (`far`): só permissão e erro, como ícone
 * compacto. Cabeça fora da tela, atrás da câmera ou escondida (sala fora do
 * frustum, foco no monitor) não é posicionada — o balão só some.
 * Nada aloca por quadro: uma entrada por agente e as caixas do layout, reaproveitadas.
 */
import { Vector3, type Camera } from 'three'
import { BubbleLayout, HEAD_CLEAR, isCompact, isFlipped, liftOf, newBox, SLOT_FRESH, SLOT_NONE, type BubbleBox } from './bubbleLayout'
import type { AgentEvent, AgentStatus, OfficeSnapshot } from './events'
import {
  COMPACT_H,
  COMPACT_W,
  createBubbleLayer,
  createQuipEngine,
  FONT_PX,
  seededRng,
  type BubbleLayer,
  type BubbleStack,
  type PowerQuipInput,
  type Quip,
  type QuipEngine,
  type QuipKind,
  type Rng
} from './quips'

export const MAX_BUBBLES = 7
/** Tique do gerador sem feed (ms). */
export const QUIP_TICK_MS = 250
/** Ponta do balão acima do centro da cabeça (m): passa da bateria e do indicador. */
export const ANCHOR_UP = 0.7
/** Na disputa, quem estava melhor no quadro anterior (à vista; mais embaixo na pilha) conta como se estivesse mais perto (×). */
const STICKY = 0.8
/** Escala pela distância da cabeça (m): 1 até SCALE_NEAR_M, cai em linha reta até MID_SCALE em SCALE_MID_M. */
export const SCALE_NEAR_M = 12
export const SCALE_MID_M = 22
export const MID_SCALE = 0.8
/** A escala nunca deixa a fonte do balão abaixo disto (px efetivos). */
export const MIN_FONT_PX = 11
/** A linha-guia do balão empilhado acaba logo acima da cabeça: esta fração do caminho cabeça → ponta sem empilhar (onde a ponta presa pela barra para). */
const LEAD_END = HEAD_CLEAR
/**
 * Nenhum balão passa disto (px do topo do palco): a barra do 3D (office3d.css .o3d-bar,
 * top 8 + ~41 px) fica por cima dos balões. O da cabeça desce até caber; o empilhado não sobe além.
 */
export const BUBBLE_TOP = 56

const NO_EVENTS: readonly AgentEvent[] = []
/** O que ainda aparece com zoom LONGE. */
export const FAR_KINDS: ReadonlySet<QuipKind> = new Set<QuipKind>(['permission', 'error'])

/** Escala do balão de uma cabeça a `distance` m da câmera: 1 perto, MID_SCALE no médio, fonte ≥ MIN_FONT_PX. */
export function bubbleScale(distance: number): number {
  if (!(distance > SCALE_NEAR_M)) return 1
  const t = Math.min(1, (distance - SCALE_NEAR_M) / (SCALE_MID_M - SCALE_NEAR_M))
  return Math.max(MIN_FONT_PX / FONT_PX, 1 - (1 - MID_SCALE) * t)
}

interface Entry {
  readonly key: string
  quip: Quip
  /** Balão inteiro (px, escala 1), medido pela camada quando a fala muda. */
  w: number
  h: number
  /** Disputa do quadro: ponta sem empilhar (x, y) e centro da cabeça (hx, hy) em px; distância da câmera. */
  x: number
  y: number
  hx: number
  hy: number
  dist: number
  /** À vista no quadro anterior (folga na disputa). */
  on: boolean
  /** Neste quadro: caixa do layout (−1 = fora da escolha) e escala. */
  box: number
  scale: number
  /** Vaga do layout no quadro anterior (histerese); SLOT_FRESH se não estava na disputa. */
  slot: number
}

export type HeadLookup = (key: string, out: Vector3) => boolean

export class Speech {
  private readonly quips: QuipEngine
  private readonly layer: BubbleLayer
  private readonly layout = new BubbleLayout(MAX_BUBBLES)
  private readonly boxes: BubbleBox[] = Array.from({ length: MAX_BUBBLES }, newBox)
  private readonly entries = new Map<string, Entry>()
  private list: Entry[] = []
  private readonly top: Array<Entry | null> = new Array<Entry | null>(MAX_BUBBLES).fill(null)
  private count = 0
  private statuses: ReadonlyMap<string, AgentStatus> | null = null
  private compact = false
  private readonly head = new Vector3()
  private readonly ndc = new Vector3()
  /** Rascunho entregue à camada a cada balão (ela só copia os valores). */
  private readonly stack: BubbleStack = { compact: false, lift: 0, lx: 0, ly: 0, flip: false }
  /** Balões à vista no último place. */
  shown = 0

  constructor(container: HTMLElement, onClick: (key: string) => void, rng: Rng = seededRng(Date.now())) {
    this.quips = createQuipEngine(rng)
    this.layer = createBubbleLayer(container, { onClick })
  }

  /** `power`: energia do escritório (anúncios e festa do apagão); null sem a janela de 5h. */
  feed(snapshot: OfficeSnapshot, events: readonly AgentEvent[], now: number, power: PowerQuipInput | null = null): boolean {
    this.statuses = snapshot.agents
    return this.apply(this.quips.step(snapshot.agents, events, now, power))
  }

  tick(now: number, power: PowerQuipInput | null = null): boolean {
    return this.statuses ? this.apply(this.quips.step(this.statuses, NO_EVENTS, now, power)) : false
  }

  /** Balão atual de `key` (o que o gerador decidiu, à vista ou não). */
  quipOf(key: string): Quip | null {
    return this.entries.get(key)?.quip ?? null
  }

  private apply(out: Map<string, Quip | null>): boolean {
    let changed = false
    let members = false
    for (const [key, quip] of out) {
      if (this.layer.set(key, quip)) changed = true
      const e = this.entries.get(key)
      if (!quip) {
        if (e) {
          this.entries.delete(key)
          members = true
        }
      } else if (!e) {
        const n: Entry = { key, quip, w: 0, h: 0, x: 0, y: 0, hx: 0, hy: 0, dist: 0, on: false, box: -1, scale: 1, slot: SLOT_FRESH }
        this.layer.size(key, n)
        this.entries.set(key, n)
        members = true
      } else if (e.quip !== quip) {
        e.quip = quip
        this.layer.size(key, e)
      }
    }
    if (members) this.list = [...this.entries.values()]
    return changed
  }

  /**
   * Mais importante primeiro; no empate, o mais perto. Folga (STICKY) para quem
   * estava melhor no quadro anterior — à vista contra fora, ou na cabeça contra
   * empilhado: dois agentes à mesma distância não trocam de lugar a cada quadro.
   */
  private before(a: Entry, b: Entry): boolean {
    if (a.quip.priority !== b.quip.priority) return a.quip.priority > b.quip.priority
    const ra = a.on ? a.slot : SLOT_NONE
    const rb = b.on ? b.slot : SLOT_NONE
    return (ra < rb ? a.dist * STICKY : a.dist) < (rb < ra ? b.dist * STICKY : b.dist)
  }

  /** Entra no top (ordenado, até MAX_BUBBLES) se couber ou se for melhor que o último. */
  private consider(e: Entry): void {
    const top = this.top
    let i: number
    if (this.count < MAX_BUBBLES) i = this.count++
    else if (this.before(e, top[MAX_BUBBLES - 1]!)) i = MAX_BUBBLES - 1
    else return
    top[i] = e
    for (; i > 0 && this.before(top[i]!, top[i - 1]!); i--) {
      const t = top[i - 1]
      top[i - 1] = top[i]
      top[i] = t
    }
  }

  /** Um quadro: escolhe e posiciona (px do palco `width`×`height`). `head` = centro da cabeça no mundo, false se escondido. */
  place(camera: Camera, width: number, height: number, far: boolean, head: HeadLookup): void {
    if (far !== this.compact) {
      this.compact = far
      this.layer.compact(far)
    }
    this.count = 0
    const list = this.list
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      e.box = -1
      if (far && !FAR_KINDS.has(e.quip.kind)) continue
      if (!head(e.key, this.head)) continue
      const p = this.ndc.copy(this.head).project(camera)
      // Fora da tela (ou atrás da câmera: z > 1): não posiciona.
      if (p.z > 1 || p.z < -1 || p.x < -1 || p.x > 1 || p.y < -1 || p.y > 1) continue
      e.hx = ((p.x + 1) / 2) * width
      e.hy = ((1 - p.y) / 2) * height
      e.dist = this.head.distanceTo(camera.position)
      this.ndc.set(this.head.x, this.head.y + ANCHOR_UP, this.head.z).project(camera)
      e.x = ((this.ndc.x + 1) / 2) * width
      e.y = ((1 - this.ndc.y) / 2) * height
      this.consider(e)
    }
    // Lugar na ordem da escolha: o mais importante escolhe primeiro.
    for (let k = 0; k < this.count; k++) {
      const e = this.top[k]!
      const b = this.boxes[k]
      e.box = k
      e.scale = far ? 1 : bubbleScale(e.dist)
      b.ax = e.x
      b.ay = e.y
      b.hy = e.hy
      b.w = e.w * e.scale
      b.h = e.h * e.scale
      b.prev = e.slot
    }
    this.layout.run(this.boxes, this.count, width, BUBBLE_TOP, far, COMPACT_W, COMPACT_H)
    this.shown = 0
    const st = this.stack
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      const b = e.box >= 0 ? this.boxes[e.box] : null
      e.slot = b ? b.slot : SLOT_FRESH
      if (!b || b.slot === SLOT_NONE) {
        e.on = false
        this.layer.place(e.key, 0, 0, 1, false)
        continue
      }
      e.on = true
      this.shown++
      st.compact = isCompact(b.slot)
      st.lift = liftOf(b.slot)
      st.flip = isFlipped(b.slot)
      st.lx = e.hx + (e.x - e.hx) * LEAD_END
      st.ly = e.hy + (e.y - e.hy) * LEAD_END
      this.layer.place(e.key, b.x, b.y, st.compact ? 1 : e.scale, true, st)
    }
  }

  dispose(): void {
    this.layer.dispose()
    this.entries.clear()
    this.list = []
    this.top.fill(null)
    this.count = 0
    this.statuses = null
  }
}
