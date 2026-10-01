// Derivado de pixel-agents (MIT, (c) 2026 Pablo De Lucca) — ver ../LICENSE-pixel-agents.md

import { OK_BUBBLE_DURATION_SEC, REACTION_ARRIVE_SEC } from './constants'
import { CharacterState, type BubbleKind, type Character, type PropKind, type ReactionKind } from './types'
import type { OfficeWorld } from './world'

/**
 * Sem duração explícita, o "ok" some sozinho (era o checkmark de turno
 * concluído do original) e os demais ficam até alguém limpar — permissão e
 * pergunta esperam o usuário, não um relógio.
 */
function defaultDuration(kind: BubbleKind): number {
  return kind === 'ok' ? OK_BUBBLE_DURATION_SEC : Infinity
}

export function showBubble(world: OfficeWorld, id: number, kind: BubbleKind, durationSec?: number): void {
  const ch = world.characters.get(id)
  if (!ch || ch.leaving) return
  const d = durationSec ?? defaultDuration(kind)
  ch.bubble = kind
  ch.bubbleTimer = d > 0 ? d : Infinity
}

/** Sem kind, limpa qualquer balão; com kind, só se for aquele (outro balão fica). */
export function clearBubble(world: OfficeWorld, id: number, kind?: BubbleKind): void {
  const ch = world.characters.get(id)
  if (!ch || !ch.bubble) return
  if (kind !== undefined && ch.bubble !== kind) return
  ch.bubble = null
  ch.bubbleTimer = 0
}

export function tickBubble(ch: Character, dt: number): void {
  if (!ch.bubble || ch.bubbleTimer === Infinity) return
  ch.bubbleTimer -= dt
  if (ch.bubbleTimer <= 0) {
    ch.bubble = null
    ch.bubbleTimer = 0
  }
}

/**
 * Mostra uma reação (kind null = nenhuma agora). Com onArrive, a reação de
 * saída fica enquanto ele anda e troca por onArrive assim que para — é só
 * desenho: não mexe no caminho, então nunca atrasa a caminhada.
 */
export function showReaction(
  world: OfficeWorld,
  id: number,
  kind: ReactionKind | null,
  durationSec: number,
  onArrive: ReactionKind | null = null
): void {
  const ch = world.characters.get(id)
  if (!ch || ch.leaving) return
  ch.reaction = kind
  ch.reactionTimer = kind ? Math.max(0, durationSec) : 0
  ch.reactionOnArrive = onArrive
}

export function tickReaction(ch: Character, dt: number): void {
  if (ch.leaving) {
    ch.reaction = null
    ch.reactionOnArrive = null
    return
  }
  if (ch.reactionOnArrive) {
    // Andando: continua emburrado. Parou: muda na hora.
    if (ch.state === CharacterState.WALK) return
    ch.reaction = ch.reactionOnArrive
    ch.reactionTimer = REACTION_ARRIVE_SEC
    ch.reactionOnArrive = null
    return
  }
  if (!ch.reaction) return
  ch.reactionTimer -= dt
  if (ch.reactionTimer <= 0) {
    ch.reaction = null
    ch.reactionTimer = 0
  }
}

export function setProp(world: OfficeWorld, id: number, prop: PropKind | null, tint: string | null = null): void {
  const ch = world.characters.get(id)
  if (!ch) return
  ch.prop = prop
  ch.propTint = prop ? tint : null
}

/** Legenda curta sobre a cabeça por `durationSec` (null limpa). */
export function showCaption(world: OfficeWorld, id: number, text: string | null, durationSec: number): void {
  const ch = world.characters.get(id)
  if (!ch || ch.leaving) return
  ch.caption = text
  ch.captionTimer = text ? Math.max(0, durationSec) : 0
}

export function tickCaption(ch: Character, dt: number): void {
  if (!ch.caption) return
  ch.captionTimer -= dt
  if (ch.captionTimer <= 0) {
    ch.caption = null
    ch.captionTimer = 0
  }
}
