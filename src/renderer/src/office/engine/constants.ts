// Derivado de pixel-agents (MIT, (c) 2026 Pablo De Lucca) — ver ../LICENSE-pixel-agents.md

import type { FurnitureKind, Pose } from './types'

/**
 * A arte é nativa em 8 px (personagem ~6×10, cadeira 8×8). O original usava
 * 16 px; tudo o que é medido em pixels de mundo foi dividido por 2 para manter
 * as mesmas proporções — velocidade em tiles/s, offsets em fração do tile.
 * Não há MAX_COLS/MAX_ROWS: o limite 64×64 do original era só do editor.
 */
export const TILE_SIZE = 8

// ── Laço ─────────────────────────────────────────────────────
/** Um quadro atrasado (aba em segundo plano) não teletransporta ninguém. */
export const MAX_DELTA_TIME_SEC = 0.1

// ── Animação do personagem ───────────────────────────────────
/** 48 px/s em 16 px = 3 tiles/s; mantido em 8 px. */
export const WALK_SPEED_PX_PER_SEC = 24
export const WALK_FRAME_DURATION_SEC = 0.15
export const TYPE_FRAME_DURATION_SEC = 0.3
export const WANDER_PAUSE_MIN_SEC = 2.0
export const WANDER_PAUSE_MAX_SEC = 20.0
export const WANDER_MOVES_BEFORE_REST_MIN = 3
export const WANDER_MOVES_BEFORE_REST_MAX = 6
export const SEAT_REST_MIN_SEC = 120.0
export const SEAT_REST_MAX_SEC = 240.0
/** Mandado ao assento estando inativo: fica sentado um pouco antes de levantar. */
export const INACTIVE_SEAT_TIMER_MIN_SEC = 3.0
export const INACTIVE_SEAT_TIMER_RANGE_SEC = 2.0

/** Quadros por pose. A arte recebe frame já reduzido a este intervalo. */
export const POSE_FRAMES: Readonly<Record<Pose, number>> = {
  stand: 1,
  walk: 2,
  walkBack: 2,
  sit: 1,
  sitType: 2,
  sitRead: 2
}

// ── Balões ───────────────────────────────────────────────────
export const BUBBLE_FADE_DURATION_SEC = 0.5
/** O "ok" some sozinho, como o checkmark de turno concluído do original. */
export const OK_BUBBLE_DURATION_SEC = 2.0
/** Quanto dura a reação de chegada (o 'feliz' na frente do chefe). */
export const REACTION_ARRIVE_SEC = 2.0

// ── Render (pixels de mundo, já em 8 px) ─────────────────────
/** Sentado, o sprite desce para "entrar" na cadeira (6 px em 16 → 3 em 8). */
export const CHARACTER_SITTING_OFFSET_PX = 3
/** Personagem ordena pela base do tile, um pouco à frente do móvel da mesma linha. */
export const CHARACTER_Z_SORT_OFFSET = 0.5
export const OUTLINE_Z_SORT_OFFSET = 0.001
export const PROP_Z_SORT_OFFSET = 0.002
export const SELECTED_OUTLINE_ALPHA = 1.0
export const HOVERED_OUTLINE_ALPHA = 0.5
export const BUBBLE_SITTING_OFFSET_PX = 5
export const BUBBLE_VERTICAL_OFFSET_PX = 12
/** Objeto de mão/cabeça: canto inferior esquerdo relativo aos pés do personagem. */
export const PROP_OFFSET_X_PX = 2
export const PROP_OFFSET_Y_PX = 5
export const CHARACTER_HIT_HALF_WIDTH = 4
export const CHARACTER_HIT_HEIGHT = 12

/**
 * Móveis rente ao chão (ou embutidos na parede) que ninguém atravessa por trás:
 * vão para o fundo estático em vez de entrar no z-sort de cada quadro.
 */
export const FLOOR_LAYER_KINDS: ReadonlySet<FurnitureKind> = new Set<FurnitureKind>(['entrada', 'porta'])

// ── Câmera ───────────────────────────────────────────────────
export const CAMERA_FOLLOW_LERP = 0.1
export const CAMERA_FOLLOW_SNAP_THRESHOLD = 0.5
/** Quanto do viewport o mapa sempre ocupa, por mais que se arraste. */
export const PAN_MARGIN_FRACTION = 0.25

// ── Zoom (inteiro: pixel-art só fica nítida em múltiplos exatos) ──
/** Com tiles de 8 px, o 1–10 do original vira 1–20 para o mesmo tamanho máximo na tela. */
export const ZOOM_MIN = 1
export const ZOOM_MAX = 20

export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000
