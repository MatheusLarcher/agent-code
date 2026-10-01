/**
 * OfficeDirector: aplica o OfficeModel no OfficeState por diff — só chama o
 * motor no que mudou desde o apply anterior.
 *
 * - Mapa chave → id numérico estável: a mesma chave ('conv:<cid>',
 *   'role:<roomId>:<papel>[:reforco]', 'track:<id>', 'po:<roomId>',
 *   'vigia:<cid>') volta sempre com o mesmo id de agente. Subagentes ('beside')
 *   recebem o id negativo do motor (addSubagent), estável por pai + chave.
 * - O layout (buildBuilding + rebuildFromLayout) só é refeito quando muda o
 *   conjunto/ordem das salas ou a lotação (fileiras de mesa) de alguma.
 * - A volta ao ocioso espera IDLE_DELAY_MS no relógio injetado; atividade nova
 *   dentro da janela cancela a volta (evita piscar entre ferramentas).
 * - onEvent(convId) acorda o principal da conversa (lazer, F1·5) quando há
 *   `leisure`; sem ele, é no-op.
 * - Reações (F3·3-5), com `reactions`: chamado à reunião, 'ok' (fim), 'erro'
 *   (inclui o ✗ do crítico) e trilha que encerra bem viram momentos-chave; a
 *   ampulheta (travamento) só mexe no humor.
 */
import type { CrewRole } from '../../crew'
import { lookFor } from '../art/roles'
import type { Leisure } from '../behavior/leisure'
import type { MoodSignal } from '../behavior/reactions'
import type { OfficeState } from '../engine/officeState'
import type { Activity, BubbleKind } from '../engine/types'
import { buildBuilding, DESKS_PER_ROW, BASE_PRINCIPALS, stableRoomOrder } from '../layout'
import type { OfficeCharacterModel, OfficeModel } from './model'
import type { ReactionDriver } from './reactionDriver'

export const IDLE_DELAY_MS = 300
/** Duração do balão "ok" no motor, em segundos. */
const OK_BUBBLE_SEC = 2

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface DirectorOptions {
  scheduler?: Scheduler
  leisure?: Pick<Leisure, 'wake' | 'forget'> & Partial<Pick<Leisure, 'modeOf'>>
  /** Reações dos momentos-chave; sem ele, ninguém reage. */
  reactions?: ReactionDriver
  /** Chamado à reunião deu certo: corta a animação em curso (pedido vence enfeite). */
  onHold?: (id: number) => void
}

export interface LookupInfo {
  key: string
  convId: string
  role: CrewRole
  trackId?: string
}

interface Live {
  model: OfficeCharacterModel
  id: number
  /** Pai no motor, para os subagentes ('beside'). */
  parentId: number | null
  active: boolean
  activity: Activity
  bubble: BubbleKind | null
  label: string
  context: string
  idleTimer: unknown
  /** Na reunião (meetingDriver): trabalho desligado e preso lá até soltar. */
  held: boolean
}

const defaultScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

/** Lotação que muda o layout: mesas por sala, em fileiras de DESKS_PER_ROW. */
function capacity(principals: number): number {
  return Math.max(BASE_PRINCIPALS, Math.ceil(principals / DESKS_PER_ROW) * DESKS_PER_ROW)
}

/** Mesma colocação = pode ser atualizado no lugar; diferente = sai e entra de novo. */
function samePlacement(a: OfficeCharacterModel, b: OfficeCharacterModel): boolean {
  return a.roomId === b.roomId && JSON.stringify(a.placement) === JSON.stringify(b.placement)
}

export class OfficeDirector {
  private readonly scheduler: Scheduler
  private readonly leisure?: DirectorOptions['leisure']
  private readonly reactions?: ReactionDriver
  private readonly onHold?: (id: number) => void
  private readonly ids = new Map<string, number>()
  private nextId = 1
  private readonly live = new Map<string, Live>()
  private readonly byId = new Map<number, LookupInfo>()
  private order: string[] = []
  /** Ids presos na reunião: consultado pelo lazer a cada tique, por isso um Set. */
  private readonly heldIds = new Set<number>()
  private layoutSig: string | null = null

  constructor(
    private readonly state: OfficeState,
    opts: DirectorOptions = {}
  ) {
    this.scheduler = opts.scheduler ?? defaultScheduler
    this.leisure = opts.leisure
    this.reactions = opts.reactions
    this.onHold = opts.onHold
  }

  /** Sinal que só mexe no humor do personagem (limite de uso, travamento…). */
  moodSignal(key: string, signal: MoodSignal): void {
    const l = this.live.get(key)
    if (l) this.reactions?.mood(l.id, signal)
  }

  /** Quem é o personagem sob o mouse / clicado. */
  lookup(id: number): LookupInfo | undefined {
    return this.byId.get(id)
  }

  /** Id numérico atual de uma chave do modelo (null = fora do mapa). */
  idOf(key: string): number | null {
    return this.live.get(key)?.id ?? null
  }

  /** Chave do personagem que mostra a trilha `trackId` (null = ninguém no mapa). */
  keyOfTrack(trackId: string): string | null {
    for (const l of this.live.values()) if (l.model.trackId === trackId) return l.model.key
    return null
  }

  /** Modelo atual do personagem de id `id` (o lugar dele, para a volta da animação). */
  modelOf(id: number): OfficeCharacterModel | undefined {
    const info = this.byId.get(id)
    return info ? this.live.get(info.key)?.model : undefined
  }

  /** ✗ do crítico: o EXECUTOR revisado se frustra (momento-chave de erro). */
  reviewFailed(key: string): void {
    const l = this.live.get(key)
    if (l) this.reactions?.failed(l.id, { critic: true, openTracks: this.openTracks(l) })
  }

  /** Evento da conversa: acorda o principal dela do lazer. */
  onEvent(convId: string): void {
    const live = this.live.get(`conv:${convId}`)
    const ch = live ? this.state.getCharacter(live.id) : undefined
    if (ch && this.leisure) this.leisure.wake(ch)
  }

  /** O personagem está preso na reunião (o lazer não age sobre ele). */
  isHeld(id: number): boolean {
    return this.heldIds.has(id)
  }

  /**
   * Leva o principal `key` à reunião (on) caminhando até o destino 'reuniao'
   * da sala, ou o devolve à mesa (off). Sem destino alcançável, devolve false
   * e nada muda: fica onde está, só com o balão do modelo.
   */
  meetingHold(key: string, on: boolean): boolean {
    const l = this.live.get(key)
    if (!l || l.parentId !== null || on === l.held) return on === l?.held
    if (on) {
      // Lido antes de acordar/desligar: alimenta a reação do chamado.
      const busy = l.active || l.activity !== null
      const mode = this.leisure?.modeOf?.(l.id) ?? null
      // Desliga o trabalho ANTES de andar: setAgentActive(false) zera o caminho.
      const active = l.active
      const activity = l.activity
      this.cancelIdle(l)
      this.setWork(l, false, null)
      if (!this.state.walkToDestination(l.id, 'reuniao')) {
        this.setWork(l, active, activity)
        return false
      }
      l.held = true
      this.heldIds.add(l.id)
      this.onHold?.(l.id)
      const ch = this.state.getCharacter(l.id)
      if (ch && this.leisure) this.leisure.wake(ch)
      // Depois do walk: a cara de chegada espera ele parar de andar.
      this.reactions?.chamado(l.id, { busy, leisure: mode, reviewer: l.model.role === 'critico', openTracks: this.openTracks(l) })
      return true
    }
    this.reactions?.released(l.id)
    l.held = false
    this.heldIds.delete(l.id)
    this.setWork(l, l.model.active, l.model.activity)
    this.state.sendToSeat(l.id)
    return true
  }

  apply(model: OfficeModel): void {
    const next = new Map(model.characters.map((c) => [c.key, c]))
    // 1) Quem saiu (ou mudou de lugar): filhos antes dos pais.
    const gone = [...this.live.values()].filter((l) => {
      const n = next.get(l.model.key)
      return !n || !samePlacement(l.model, n) || (l.parentId !== null && this.parentChanged(l, n))
    })
    gone.sort((a, b) => Number(b.parentId !== null) - Number(a.parentId !== null))
    // Trilha que encerra sem erro, com o pai ainda no mapa: 'fim' para o pai.
    const doneParents = gone
      .filter((l) => l.parentId !== null && l.model.trackId && l.bubble !== 'erro' && next.has(this.parentKey(l)))
      .map((l) => this.parentKey(l))
    for (const l of gone) this.remove(l)

    // 2) Layout, só quando salas ou lotação mudam.
    this.order = stableRoomOrder(this.order, model.rooms.map((r) => r.id))
    const sig = this.order.join('|') + '#' + model.rooms.map((r) => `${r.id}:${capacity(r.principals)}`).join('|')
    if (sig !== this.layoutSig) {
      this.layoutSig = sig
      const layout = buildBuilding({
        rooms: model.rooms.map((r) => ({ id: r.id, projectKey: r.projectKey, name: r.name, principals: r.principals })),
        order: this.order
      })
      this.state.rebuildFromLayout(layout)
    }

    // 3) Entradas e atualizações, na ordem do modelo (pais primeiro).
    for (const c of model.characters) {
      const l = this.live.get(c.key) ?? this.add(c)
      if (!l) continue
      l.model = c
      this.byId.set(l.id, { key: c.key, convId: c.convId, role: c.role, ...(c.trackId ? { trackId: c.trackId } : {}) })
      this.sync(l, c)
    }
    for (const key of doneParents) {
      const p = this.live.get(key)
      if (p) this.reactions?.finished(p.id, { openTracks: this.openTracks(p) })
    }
  }

  /** Cancela timers pendentes (a aba fechou). */
  dispose(): void {
    for (const l of this.live.values()) this.cancelIdle(l)
  }

  private parentKey(l: Live): string {
    return l.model.placement.kind === 'beside' ? l.model.placement.parentKey : ''
  }

  /** Delegações abertas: subagentes vivos ao lado dele. */
  private openTracks(l: Live): number {
    let n = 0
    for (const o of this.live.values()) if (o.parentId === l.id) n++
    return n
  }

  private parentChanged(l: Live, n: OfficeCharacterModel): boolean {
    if (n.placement.kind !== 'beside') return true
    return this.live.get(n.placement.parentKey)?.id !== l.parentId
  }

  private add(c: OfficeCharacterModel): Live | null {
    const look = lookFor(c.role, c.seed)
    let id: number
    let parentId: number | null = null
    const p = c.placement
    if (p.kind === 'beside') {
      const parent = this.live.get(p.parentKey)
      if (!parent) return null
      parentId = parent.id
      id = this.state.addSubagent(parent.id, c.key, look)
      this.state.setLabel(id, c.label)
    } else {
      id = this.ids.get(c.key) ?? this.nextId++
      this.ids.set(c.key, id)
      this.state.addAgent(id, {
        roomId: c.roomId,
        look,
        label: c.label,
        ...(p.seatKind ? { seatKind: p.seatKind } : {}),
        ...(p.slot ? { slot: p.slot } : {})
      })
      if (p.kind === 'destination') this.state.walkToDestination(id, p.papel)
    }
    const l: Live = {
      model: c,
      id,
      parentId,
      // O motor cria o personagem ativo; o estado do modelo vai direto, sem atraso.
      active: true,
      activity: null,
      bubble: null,
      label: c.label,
      context: '',
      idleTimer: null,
      held: false
    }
    this.live.set(c.key, l)
    if (!c.active) {
      // Chegou ocioso: setAgentActive(false) zeraria o caminho até a mesa e ele
      // pararia na porta. Só desliga a flag e deixa o motor terminar a entrada.
      const ch = this.state.getCharacter(id)
      if (ch) ch.isActive = false
      l.active = false
    }
    this.setWork(l, c.active, c.activity)
    return l
  }

  private remove(l: Live): void {
    this.cancelIdle(l)
    this.heldIds.delete(l.id)
    this.live.delete(l.model.key)
    this.byId.delete(l.id)
    if (l.parentId !== null) this.state.removeSubagent(l.parentId, l.model.key)
    else this.state.removeAgent(l.id)
    this.leisure?.forget(l.id)
    this.reactions?.forget(l.id)
  }

  private sync(l: Live, c: OfficeCharacterModel): void {
    if (l.held) {
      // Na reunião o trabalho fica desligado; volta quando o driver soltar.
      this.cancelIdle(l)
    } else if (c.active || c.activity) {
      this.cancelIdle(l)
      this.setWork(l, c.active, c.activity)
    } else if ((l.active || l.activity) && l.idleTimer === null) {
      l.idleTimer = this.scheduler.setTimeout(() => {
        l.idleTimer = null
        if (this.live.get(l.model.key) === l) this.setWork(l, false, null)
      }, IDLE_DELAY_MS)
    }
    if (c.bubble !== l.bubble) {
      if (c.bubble === null) this.state.clearBubble(l.id)
      else this.state.showBubble(l.id, c.bubble, c.bubble === 'ok' ? OK_BUBBLE_SEC : undefined)
      l.bubble = c.bubble
      this.momentFor(l, c)
    }
    if (c.label !== l.label) {
      this.state.setLabel(l.id, c.label)
      l.label = c.label
    }
    const ctx = c.context ? `${c.context.tokens}/${c.context.max}` : ''
    if (c.context && ctx !== l.context) this.state.setAgentContext(l.id, c.context.tokens, c.context.max)
    l.context = ctx
  }

  /** Balão novo → momento-chave (ou só humor, na ampulheta). */
  private momentFor(l: Live, c: OfficeCharacterModel): void {
    const r = this.reactions
    if (!r) return
    const info = { reviewer: c.role === 'critico', openTracks: this.openTracks(l) }
    if (c.bubble === 'ok') r.finished(l.id, info)
    else if (c.bubble === 'erro') r.failed(l.id, { ...info, critic: c.role === 'critico' })
    else if (c.bubble === 'ampulheta') r.mood(l.id, 'travamento')
  }

  private setWork(l: Live, active: boolean, activity: Activity): void {
    this.reactions?.work(l.id, active, activity, l.activity)
    if (activity !== l.activity) {
      this.state.setAgentTool(l.id, activity)
      l.activity = activity
    }
    if (active !== l.active) {
      this.state.setAgentActive(l.id, active)
      l.active = active
    }
  }

  private cancelIdle(l: Live): void {
    if (l.idleTimer === null) return
    this.scheduler.clearTimeout(l.idleTimer)
    l.idleTimer = null
  }
}
