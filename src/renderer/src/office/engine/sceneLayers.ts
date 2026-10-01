// Derivado de pixel-agents (MIT, (c) 2026 Pablo De Lucca) — ver ../LICENSE-pixel-agents.md

/**
 * O QUE desenhar e em que ordem, em pixels de mundo — sem tocar em canvas.
 * O renderer só rasteriza esta lista; separado assim, a ordem de profundidade
 * (z-sort por Y do original) e o "monitor ligado" dão para testar no jsdom.
 */

import { characterPose, isSeated } from './characters'
import {
  BUBBLE_FADE_DURATION_SEC,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_Z_SORT_OFFSET,
  FLOOR_LAYER_KINDS,
  HOVERED_OUTLINE_ALPHA,
  OUTLINE_Z_SORT_OFFSET,
  PROP_OFFSET_X_PX,
  PROP_OFFSET_Y_PX,
  PROP_Z_SORT_OFFSET,
  SELECTED_OUTLINE_ALPHA,
  TILE_SIZE
} from './constants'
import { getOutlineSprite } from './spriteCache'
import type { Character, OfficeArt, OfficeLayout, PlacedFurniture, SpriteData } from './types'

export interface SceneItem {
  sprite: SpriteData
  /** Canto superior esquerdo, pixels de mundo. */
  x: number
  y: number
  /** Profundidade: maior = mais à frente = desenhado depois. */
  zY: number
  alpha: number
}

/** O pedaço do OfficeState que a cena lê (a classe satisfaz isto). */
export interface SceneSource {
  layout: OfficeLayout
  characters: Map<number, Character>
  selectedAgentId: number | null
  hoveredAgentId: number | null
  time: number
  activeFurnitureUids(): Set<string>
}

/** Rente ao chão: vai para o fundo estático, fora do z-sort. */
export function isStaticFurniture(f: PlacedFurniture): boolean {
  return FLOOR_LAYER_KINDS.has(f.kind)
}

/**
 * Sprite apoiado na BASE do footprint e crescendo para cima — a mesa com o
 * monitor acima, o quadro na parede. A profundidade é a base do footprint:
 * quem está na linha de baixo passa na frente, quem está atrás fica escondido.
 * (No original zY = y + altura do sprite, que é o mesmo quando o sprite tem a
 * altura do footprint.)
 */
export function furnitureItem(f: PlacedFurniture, sprite: SpriteData): SceneItem {
  const base = (f.row + f.h) * TILE_SIZE
  return { sprite, x: f.col * TILE_SIZE, y: base - sprite.length, zY: base, alpha: 1 }
}

function spriteWidth(s: SpriteData): number {
  return s.length > 0 ? s[0].length : 0
}

/** Móveis do fundo estático (desenhados uma vez, sem animação nem estado). */
export function backgroundFurnitureItems(layout: OfficeLayout, art: OfficeArt): SceneItem[] {
  const out: SceneItem[] = []
  for (const f of layout.furniture) {
    if (!isStaticFurniture(f)) continue
    const sprite = art.furnitureSprite(f, { active: false, t: 0 })
    if (sprite) out.push(furnitureItem(f, sprite))
  }
  return out
}

function characterItems(ch: Character, src: SceneSource, art: OfficeArt, out: SceneItem[]): void {
  const { pose, frame } = characterPose(ch)
  const sprite = art.characterSprite(ch.look, pose, frame)
  const sitOff = isSeated(ch) ? CHARACTER_SITTING_OFFSET_PX : 0
  // Ancorado embaixo no centro: (ch.x, ch.y) são os pés.
  const x = ch.x - spriteWidth(sprite) / 2
  const y = ch.y + sitOff - sprite.length
  // Ordena pela base do tile (não pelo centro): fica na frente da cadeira da
  // mesma linha e atrás do móvel da linha de baixo.
  const zY = ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET

  const selected = src.selectedAgentId === ch.id
  if (selected || src.hoveredAgentId === ch.id) {
    out.push({
      sprite: getOutlineSprite(sprite),
      x: x - 1,
      y: y - 1,
      zY: zY - OUTLINE_Z_SORT_OFFSET,
      alpha: selected ? SELECTED_OUTLINE_ALPHA : HOVERED_OUTLINE_ALPHA
    })
  }
  out.push({ sprite, x, y, zY, alpha: 1 })

  if (ch.prop) {
    const prop = art.propSprite(ch.prop, ch.propTint)
    out.push({
      sprite: prop,
      x: ch.x + PROP_OFFSET_X_PX,
      y: ch.y + sitOff - PROP_OFFSET_Y_PX - prop.length,
      zY: zY + PROP_Z_SORT_OFFSET,
      alpha: 1
    })
  }
}

/** Móveis animados/ligáveis + personagens + objetos, já em ordem de desenho. */
export function buildSceneItems(src: SceneSource, art: OfficeArt): SceneItem[] {
  const items: SceneItem[] = []
  const active = src.activeFurnitureUids()
  for (const f of src.layout.furniture) {
    if (isStaticFurniture(f)) continue
    const sprite = art.furnitureSprite(f, { active: active.has(f.uid), t: src.time })
    if (sprite) items.push(furnitureItem(f, sprite))
  }
  for (const ch of src.characters.values()) characterItems(ch, src, art, items)
  // sort é estável: empate mantém móvel antes de personagem, como no original.
  return items.sort((a, b) => a.zY - b.zY)
}

export interface CaptionItem {
  text: string
  /** Centro do texto e base, em pixels de mundo. */
  x: number
  y: number
  alpha: number
}

/**
 * Legendas ('3 cartões', '+1 memória'): texto sobre a cabeça, acima do balão.
 * '…' e '?' ganham delas também: com esses balões a legenda não aparece.
 */
export function buildCaptionItems(src: Pick<SceneSource, 'characters'>): CaptionItem[] {
  const out: CaptionItem[] = []
  for (const ch of src.characters.values()) {
    if (!ch.caption || ch.bubble === 'permissao' || ch.bubble === 'pergunta') continue
    const sitOff = isSeated(ch) ? BUBBLE_SITTING_OFFSET_PX : 0
    const alpha = ch.captionTimer < BUBBLE_FADE_DURATION_SEC ? Math.max(0, ch.captionTimer / BUBBLE_FADE_DURATION_SEC) : 1
    out.push({ text: ch.caption, x: ch.x, y: ch.y + sitOff - BUBBLE_VERTICAL_OFFSET_PX - 12, alpha })
  }
  return out
}

/** Balões: sempre por cima da cena; somem com fade no fim do prazo. */
export function buildBubbleItems(src: SceneSource, art: OfficeArt): SceneItem[] {
  const items: SceneItem[] = []
  for (const ch of src.characters.values()) {
    const sitOff = isSeated(ch) ? BUBBLE_SITTING_OFFSET_PX : 0
    // '…' e '?' sempre ganham: com eles a reação nem é desenhada.
    const waiting = ch.bubble === 'permissao' || ch.bubble === 'pergunta'
    if (ch.reaction && !waiting && art.reactionSprites) {
      const r = art.reactionSprites(ch.reaction)
      const t = ch.reactionOnArrive ? Infinity : ch.reactionTimer
      const alpha = t < BUBBLE_FADE_DURATION_SEC ? Math.max(0, t / BUBBLE_FADE_DURATION_SEC) : 1
      const y = ch.y + sitOff - BUBBLE_VERTICAL_OFFSET_PX - r.bubble.length - 1
      const x = ch.x - spriteWidth(r.bubble) / 2
      items.push({ sprite: r.bubble, x, y, zY: ch.y, alpha })
      // Adereço sobreposto colado à direita do balão (fumaça, gota, confete…).
      if (r.prop) items.push({ sprite: r.prop, x: x + spriteWidth(r.bubble), y, zY: ch.y, alpha })
      continue
    }
    if (!ch.bubble) {
      // Ondas de som (leitura em voz): só sem outro balão por cima.
      if (ch.speaking && art.wavesSprite) {
        const w = art.wavesSprite(Math.floor(src.time * 4))
        items.push({ sprite: w, x: ch.x - spriteWidth(w) / 2, y: ch.y + sitOff - BUBBLE_VERTICAL_OFFSET_PX - w.length - 1, zY: ch.y, alpha: 1 })
      }
      continue
    }
    const sprite = art.bubbleSprite(ch.bubble)
    const alpha = ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC ? Math.max(0, ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC) : 1
    items.push({
      sprite,
      x: ch.x - spriteWidth(sprite) / 2,
      y: ch.y + sitOff - BUBBLE_VERTICAL_OFFSET_PX - sprite.length - 1,
      zY: ch.y,
      alpha
    })
  }
  return items.sort((a, b) => a.zY - b.zY)
}
