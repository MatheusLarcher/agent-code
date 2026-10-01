// Derivado de pixel-agents (MIT, (c) 2026 Pablo De Lucca) — ver ../LICENSE-pixel-agents.md

import * as agents from './agents'
import type { AddAgentOptions } from './agents'
import * as bubbles from './bubbles'
import { isSeated, updateCharacter, type CharacterContext } from './characters'
import { CHARACTER_HIT_HALF_WIDTH, CHARACTER_HIT_HEIGHT, CHARACTER_SITTING_OFFSET_PX } from './constants'
import type { SeatRequest } from './seatPlacement'
import * as subagents from './subagents'
import { CharacterState } from './types'
import type {
  Activity,
  BubbleKind,
  Character,
  CharacterLook,
  DestinationRole,
  OfficeLayout,
  PropKind,
  ReactionKind,
  Seat,
  TilePos,
  TileType
} from './types'
import {
  createSubagentRegistry,
  deriveWorld,
  forgetCharacter,
  roomTiles,
  withOwnSeatUnblocked,
  type OfficeWorld,
  type SubagentRegistry
} from './world'

/**
 * Gancho de lazer: chamado para personagem ocioso (parado ou descansando no
 * assento). Devolvendo true, substitui o perambular naquele tique — quem
 * implementa decide o que fazer com `api` (ir à copa, pegar o celular…).
 */
export type IdleBehavior = (ch: Character, dt: number, api: OfficeState) => boolean

/**
 * Estado do escritório: layout derivado + personagens. Os comportamentos
 * moram em agents/subagents/bubbles como funções puras sobre OfficeWorld; a
 * classe só guarda o estado e mantém a API pública do original.
 */
export class OfficeState implements OfficeWorld {
  layout!: OfficeLayout
  tileMap!: TileType[][]
  seats!: Map<string, Seat>
  blockedTiles!: Set<string>
  walkableTiles!: TilePos[]
  walkableByRoom!: Map<string | null, TilePos[]>
  characters = new Map<number, Character>()
  seatRequests = new Map<number, SeatRequest>()
  subagents: SubagentRegistry = createSubagentRegistry()
  selectedAgentId: number | null = null
  hoveredAgentId: number | null = null
  cameraFollowId: number | null = null
  /** Sobe a cada troca de layout: o renderer refaz o fundo estático só quando muda. */
  layoutVersion = 0
  /** Segundos de jogo acumulados — o relógio das animações de móvel. */
  time = 0
  idleBehavior?: IdleBehavior
  /** Chamado no fim de cada tique (a fila de animações anda por aqui). */
  afterUpdate?: (dt: number) => void

  constructor(layout: OfficeLayout) {
    this.applyLayout(layout)
  }

  private applyLayout(layout: OfficeLayout): void {
    // deriveWorld valida antes de qualquer atribuição: layout ruim não deixa o estado pela metade.
    const derived = deriveWorld(layout)
    this.layout = layout
    this.tileMap = derived.tileMap
    this.seats = derived.seats
    this.blockedTiles = derived.blockedTiles
    this.walkableTiles = derived.walkableTiles
    this.walkableByRoom = derived.walkableByRoom
    this.layoutVersion++
  }

  /** Troca o layout mantendo cada personagem no seu assento quando ele ainda existe. */
  rebuildFromLayout(layout: OfficeLayout): void {
    this.applyLayout(layout)
    agents.reseatAfterLayout(this)
  }

  getLayout(): OfficeLayout {
    return this.layout
  }

  // ── Agentes ───────────────────────────────────────────────────

  addAgent(id: number, opts: AddAgentOptions): void {
    agents.addAgent(this, id, opts)
  }

  removeAgent(id: number): void {
    agents.removeAgent(this, id)
  }

  setAgentActive(id: number, active: boolean): void {
    agents.setAgentActive(this, id, active)
  }

  setAgentTool(id: number, activity: Activity): void {
    agents.setAgentTool(this, id, activity)
  }

  sendToSeat(id: number): void {
    agents.sendToSeat(this, id)
  }

  walkToTile(id: number, col: number, row: number): boolean {
    return agents.walkToTile(this, id, col, row)
  }

  walkToDestination(id: number, papel: DestinationRole): boolean {
    return agents.walkToDestination(this, id, papel)
  }

  setAgentContext(id: number, contextTokens: number, maxContextTokens: number): void {
    const ch = this.characters.get(id)
    if (!ch) return
    ch.contextTokens = contextTokens
    ch.maxContextTokens = maxContextTokens
  }

  setLabel(id: number, label: string | undefined): void {
    const ch = this.characters.get(id)
    if (ch) ch.label = label
  }

  // ── Subagentes ────────────────────────────────────────────────

  addSubagent(parentAgentId: number, toolId: string, look: CharacterLook): number {
    return subagents.addSubagent(this, parentAgentId, toolId, look)
  }

  removeSubagent(parentAgentId: number, toolId: string): void {
    subagents.removeSubagent(this, parentAgentId, toolId)
  }

  removeAllSubagents(parentAgentId: number): void {
    subagents.removeAllSubagents(this, parentAgentId)
  }

  getSubagentId(parentAgentId: number, toolId: string): number | null {
    return subagents.getSubagentId(this, parentAgentId, toolId)
  }

  // ── Balões e objetos ──────────────────────────────────────────

  showBubble(id: number, kind: BubbleKind, durationSec?: number): void {
    bubbles.showBubble(this, id, kind, durationSec)
  }

  clearBubble(id: number, kind?: BubbleKind): void {
    bubbles.clearBubble(this, id, kind)
  }

  setProp(id: number, prop: PropKind | null, tint?: string | null): void {
    bubbles.setProp(this, id, prop, tint ?? null)
  }

  showCaption(id: number, text: string | null, durationSec: number): void {
    bubbles.showCaption(this, id, text, durationSec)
  }

  /** Prende (on) ou solta o personagem para uma animação; solto, o FSM volta a mandar. */
  setPinned(id: number, on: boolean): void {
    const ch = this.characters.get(id)
    if (ch && !ch.leaving) ch.pinned = on
  }

  /** Liga/desliga o balão de ondas (leitura em voz). */
  setSpeaking(id: number, on: boolean): void {
    const ch = this.characters.get(id)
    if (ch) ch.speaking = on
  }

  showReaction(id: number, kind: ReactionKind | null, durationSec: number, onArrive?: ReactionKind | null): void {
    bubbles.showReaction(this, id, kind, durationSec, onArrive ?? null)
  }

  // ── Tique ─────────────────────────────────────────────────────

  update(dt: number): void {
    this.time += dt
    const hook = this.idleBehavior
    // Um contexto só, reaproveitado por personagem: o tique roda 60×/s.
    const ctx: CharacterContext = {
      seats: this.seats,
      tileMap: this.tileMap,
      blockedTiles: this.blockedTiles,
      wanderTiles: [],
      idle: hook ? (ch, d) => hook(ch, d, this) : undefined
    }
    const gone: number[] = []
    for (const ch of this.characters.values()) {
      ctx.wanderTiles = roomTiles(this, ch.roomId)
      withOwnSeatUnblocked(this, ch, () => updateCharacter(ch, dt, ctx))
      bubbles.tickBubble(ch, dt)
      bubbles.tickReaction(ch, dt)
      bubbles.tickCaption(ch, dt)
      ch.idleSince = !ch.isActive && !ch.leaving ? ch.idleSince + dt : 0
      // Saindo e sem caminho a seguir = chegou à porta (ou não tinha como chegar).
      if (ch.leaving && ch.state !== CharacterState.WALK) gone.push(ch.id)
    }
    for (const id of gone) forgetCharacter(this, id)
    this.afterUpdate?.(dt)
  }

  // ── Leitura ───────────────────────────────────────────────────

  getCharacters(): Character[] {
    return Array.from(this.characters.values())
  }

  getCharacter(id: number): Character | undefined {
    return this.characters.get(id)
  }

  /**
   * Móveis "ligados": a mesa (seat.deskUid) e o que aponta para o assento
   * (furniture.deskOfSeat) de cada dono ativo. É o `active` do OfficeArt.
   */
  activeFurnitureUids(): Set<string> {
    const out = new Set<string>()
    const activeSeats = new Set<string>()
    for (const ch of this.characters.values()) {
      if (!ch.isActive || ch.leaving || !ch.seatId) continue
      activeSeats.add(ch.seatId)
      const desk = this.seats.get(ch.seatId)?.deskUid
      if (desk) out.add(desk)
    }
    if (activeSeats.size === 0) return out
    for (const f of this.layout.furniture) {
      if (f.deskOfSeat && activeSeats.has(f.deskOfSeat)) out.add(f.uid)
    }
    return out
  }

  /** Personagem sob o ponto (pixels de mundo); o da frente ganha. Quem está saindo não é clicável. */
  getCharacterAt(worldX: number, worldY: number): number | null {
    const ordered = Array.from(this.characters.values()).sort((a, b) => b.y - a.y)
    for (const ch of ordered) {
      if (ch.leaving) continue
      // Sprite ancorado embaixo no centro; sentado, desce junto com o desenho.
      const anchorY = ch.y + (isSeated(ch) ? CHARACTER_SITTING_OFFSET_PX : 0)
      if (
        worldX >= ch.x - CHARACTER_HIT_HALF_WIDTH &&
        worldX <= ch.x + CHARACTER_HIT_HALF_WIDTH &&
        worldY >= anchorY - CHARACTER_HIT_HEIGHT &&
        worldY <= anchorY
      ) {
        return ch.id
      }
    }
    return null
  }
}
