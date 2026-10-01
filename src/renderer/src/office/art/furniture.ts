import { TILE_SIZE } from '../engine/constants'
import type { FurnitureArtContext, FurnitureKind, PlacedFurniture, SpriteData } from '../engine/types'
import type { OfficePalette, PaletteKey } from './palette'
import { parseSprite } from './sprites'

/**
 * Móveis desenhados como texto, como o resto da arte: cada função monta as
 * linhas com letras e o parseSprite troca as letras pelas cores da paleta.
 * Largura = w × TILE_SIZE; a altura parte do footprint e cresce para cima
 * quando o móvel tem algo em cima (monitor, máquina de café, folhas).
 */

/** Letra → token da paleta. Só estas letras podem aparecer num móvel. */
export const FURNITURE_KEYS: Readonly<Record<string, PaletteKey>> = {
  d: 'desk',
  e: 'deskEdge',
  m: 'monOff',
  n: 'monOn',
  c: 'chair',
  C: 'chairBack',
  t: 'table',
  u: 'tableEdge',
  w: 'board',
  x: 'boardLine',
  p: 'paper',
  q: 'paperEdge',
  r: 'printer',
  o: 'printerLo',
  L: 'led',
  a: 'add',
  v: 'del',
  k: 'code',
  y: 'postYellow',
  z: 'postPink',
  i: 'postBlue',
  j: 'postGreen',
  g: 'wallHi',
  f: 'wallLo',
  F: 'floorB',
  s: 'steel',
  S: 'steelLo',
  b: 'coffee',
  P: 'pot',
  G: 'leaf',
  H: 'leafLo',
  R: 'rug',
  E: 'rugEdge',
  h: 'handle'
}

export function furniturePalette(pal: OfficePalette): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, token] of Object.entries(FURNITURE_KEYS)) out[k] = pal[token]
  return out
}

/** Tela de letras com retângulos recortados nas bordas. */
class Grid {
  private cells: string[][]
  constructor(
    readonly w: number,
    readonly h: number
  ) {
    this.cells = Array.from({ length: h }, () => Array<string>(w).fill('.'))
  }
  rect(k: string, x: number, y: number, w: number, h: number): this {
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++) {
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) this.cells[j][i] = k
    }
    return this
  }
  rows(): string[] {
    return this.cells.map((r) => r.join(''))
  }
}

/** Monitor: desligado (azul), digitando (linhas rolam) ou lendo (linhas paradas). */
export type MonitorMode = 'off' | 'type' | 'read'

const LINE_WIDTHS = [7, 4, 8, 5, 6]
const LINE_KEYS = ['k', 'a', 'a', 'v', 'k']
/** Passos distintos da rolagem (as 5 linhas do protótipo em ciclo). */
export const MONITOR_STEPS = LINE_WIDTHS.length

/** Altura da pilha de papéis (linhas) por degrau: 80, 90 e 95% do contexto. */
export const PILE_HEIGHTS: readonly number[] = [0, 2, 4, 6]

export function deskRows(w: number, h: number, mode: MonitorMode, step: number, pile = 0): string[] {
  const W = w * TILE_SIZE
  const H = h * TILE_SIZE + 5
  const g = new Grid(W, H)
  g.rect('d', 0, 5, W, H - 7).rect('e', 0, H - 2, W, 2)
  // Pilha de papéis no canto esquerdo da mesa, folha clara e borda alternadas.
  const ph = PILE_HEIGHTS[Math.max(0, Math.min(3, pile))]
  for (let k = 0; k < ph; k++) g.rect(k % 2 === 0 ? 'q' : 'p', 0, 6 - k, 3, 1)
  const mx = 4
  if (mode === 'off') return g.rect('m', mx, 0, 10, 7).rows()
  g.rect('n', mx, 0, 10, 7)
  const s = mode === 'type' ? step : 0
  for (let k = 0; k < 3; k++) {
    const n = (k + s) % MONITOR_STEPS
    g.rect(LINE_KEYS[n], mx + 1, 1 + k * 2, LINE_WIDTHS[n], 1)
  }
  return g.rows()
}

function chairRows(): string[] {
  return new Grid(TILE_SIZE, TILE_SIZE).rect('c', 1, 1, 6, 6).rect('C', 1, 1, 6, 2).rows()
}

function meetingTableRows(w: number, h: number): string[] {
  const W = w * TILE_SIZE
  const H = h * TILE_SIZE
  return new Grid(W, H).rect('t', 0, 0, W, H - 2).rect('u', 0, H - 2, W, 2).rows()
}

function partitionRows(w: number, h: number): string[] {
  const g = new Grid(w * TILE_SIZE, h * TILE_SIZE)
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) g.rect('g', c * TILE_SIZE, r * TILE_SIZE + 1, 8, 7)
  return g.rows()
}

/** Quadro kanban com três colunas; um post-it passa de "fazendo" para "feito". */
export function kanbanRows(w: number, h: number, moved: boolean): string[] {
  const W = Math.max(w * TILE_SIZE, 18)
  const H = Math.max(h * TILE_SIZE, 12)
  const top = H - 12
  const g = new Grid(W, H).rect('w', 0, top, W, 12)
  const col = Math.floor(W / 3)
  g.rect('x', col, top + 1, 1, 10).rect('x', 2 * col, top + 1, 1, 10)
  g.rect('y', 2, top + 2, 3, 3).rect('z', 2, top + 7, 3, 3)
  g.rect('i', col + 2, top + 2, 3, 3)
  g.rect('j', 2 * col + 2, top + 2, 3, 3)
  if (moved) g.rect('j', 2 * col + 2, top + 7, 3, 3)
  else g.rect('j', col + 2, top + 7, 3, 3)
  return g.rows()
}

/** Algarismos 3×5 do contador da impressora; '+' = mais de 9. */
const DIGITS: Readonly<Record<string, readonly string[]>> = {
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'],
  '3': ['##.', '..#', '.#.', '..#', '##.'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '##.', '..#', '##.'],
  '6': ['.##', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '##.'],
  '+': ['...', '.#.', '###', '.#.', '...']
}

/**
 * Impressora; ligada, o LED pisca e o papel sobe. `count` > 0 desenha o
 * contador (tarefas em segundo plano) no canto de cima, em verde.
 */
export function printerRows(w: number, h: number, blink: boolean, paperLift: number, count = 0): string[] {
  const W = Math.max(w * TILE_SIZE, 16)
  const H = Math.max(h * TILE_SIZE, 14)
  const g = new Grid(W, H)
  const x = Math.floor((W - 14) / 2)
  const y = H - 9
  g.rect('p', x + 3, y - 3 - paperLift, 8, 3)
  g.rect('r', x, y, 14, 9).rect('o', x, y + 7, 14, 2)
  g.rect(blink ? 'L' : 'o', x + 11, y + 2, 2, 1)
  if (count > 0) {
    const glyph = DIGITS[count > 9 ? '+' : String(count)]
    glyph.forEach((row, j) => [...row].forEach((ch, i) => ch === '#' && g.rect('L', W - 3 + i, j, 1, 1)))
  }
  return g.rows()
}

function doorRows(w: number, h: number): string[] {
  const W = w * TILE_SIZE
  const H = h * TILE_SIZE
  return new Grid(W, H).rect('F', 0, 0, W, H).rect('f', 0, 0, 2, H).rect('f', W - 2, 0, 2, H).rows()
}

function kitchenRows(w: number, h: number): string[] {
  const W = w * TILE_SIZE
  const H = h * TILE_SIZE + 6
  const g = new Grid(W, H).rect('d', 0, 6, W, H - 8).rect('e', 0, H - 2, W, 2)
  // Máquina de café com a jarra, e uma xícara ao lado.
  g.rect('s', 2, 0, 6, 8).rect('S', 3, 4, 4, 1).rect('b', 4, 5, 2, 2)
  if (W >= 14) g.rect('p', 10, 4, 3, 3).rect('b', 11, 4, 1, 1)
  return g.rows()
}

function cabinetRows(w: number, h: number): string[] {
  const W = w * TILE_SIZE
  const H = h * TILE_SIZE + 6
  const g = new Grid(W, H).rect('s', 0, 0, W, H).rect('S', 0, H - 1, W, 1)
  const dh = Math.floor((H - 1) / 3)
  for (let k = 0; k < 3; k++) {
    g.rect('S', 1, k * dh + dh - 1, W - 2, 1)
    g.rect('h', Math.floor(W / 2) - 1, k * dh + Math.floor(dh / 2), 2, 1)
  }
  return g.rows()
}

function entranceRows(w: number, h: number): string[] {
  const W = w * TILE_SIZE
  const H = h * TILE_SIZE
  return new Grid(W, H).rect('E', 0, 0, W, H).rect('R', 1, 1, W - 2, H - 2).rows()
}

function plantRows(w: number, h: number): string[] {
  const W = w * TILE_SIZE
  const H = h * TILE_SIZE + 6
  const cx = Math.floor(W / 2)
  const g = new Grid(W, H)
  g.rect('G', cx - 3, 0, 6, 7).rect('H', cx - 2, 2, 1, 4).rect('H', cx + 1, 1, 1, 5)
  g.rect('P', cx - 2, H - 7, 4, 7).rect('e', cx - 2, H - 7, 4, 1)
  return g.rows()
}

/** Linhas de um móvel num estado. Exportado para os testes percorrerem tudo. */
export function furnitureRows(kind: FurnitureKind, w: number, h: number, variant: FurnitureVariant): string[] {
  switch (kind) {
    case 'mesa':
      return deskRows(w, h, variant.monitor, variant.step, variant.pile ?? 0)
    case 'cadeira':
    case 'cadeira-reuniao':
      return chairRows()
    case 'mesa-reuniao':
      return meetingTableRows(w, h)
    case 'divisoria':
      return partitionRows(w, h)
    case 'quadro-kanban':
      return kanbanRows(w, h, variant.moved)
    case 'impressora':
      return printerRows(w, h, variant.blink, variant.paperLift, variant.count ?? 0)
    case 'porta':
      return doorRows(w, h)
    case 'copa':
      return kitchenRows(w, h)
    case 'arquivo-memorias':
      return cabinetRows(w, h)
    case 'entrada':
      return entranceRows(w, h)
    case 'planta':
      return plantRows(w, h)
  }
}

export interface FurnitureVariant {
  monitor: MonitorMode
  step: number
  moved: boolean
  blink: boolean
  paperLift: number
  /** Degrau da pilha de papéis na mesa (0..3). */
  pile?: number
  /** Contador da impressora (tarefas em segundo plano). */
  count?: number
}

/**
 * Estado visual a partir do contexto do motor. O post-it do kanban só muda de
 * coluna quando o PO cola um (F4·4-5, via a arte com sobreposições do runtime);
 * pilha e contador também vêm de lá. O contexto só traz active e t
 * (não a atividade do dono), então o monitor ligado mostra por padrão as linhas
 * rolando de "digitando"; `activeMode` permite trocar para 'read' no futuro.
 */
export function variantFor(f: PlacedFurniture, ctx: FurnitureArtContext, activeMode: MonitorMode = 'type'): FurnitureVariant {
  const v: FurnitureVariant = { monitor: 'off', step: 0, moved: false, blink: false, paperLift: 0 }
  if (f.kind === 'mesa' && ctx.active) {
    v.monitor = activeMode
    v.step = activeMode === 'type' ? Math.floor(ctx.t * 5) % MONITOR_STEPS : 0
  } else if (f.kind === 'impressora' && ctx.active) {
    v.blink = Math.floor(ctx.t * 2) % 2 === 1
    v.paperLift = Math.floor(ctx.t * 2) % 3
  }
  return v
}

/** Cache por tipo+tamanho+estado: mesma entrada → mesma referência. */
export class FurnitureSprites {
  private cache = new Map<string, SpriteData>()
  private pal: Record<string, string>

  constructor(palette: OfficePalette) {
    this.pal = furniturePalette(palette)
  }

  get(f: PlacedFurniture, ctx: FurnitureArtContext): SpriteData {
    return this.of(f, variantFor(f, ctx))
  }

  /** Sprite de uma variante já decidida (a arte com sobreposições usa esta). */
  of(f: PlacedFurniture, v: FurnitureVariant): SpriteData {
    const key = `${f.kind}|${f.w}x${f.h}|${v.monitor}|${v.step}|${v.moved}|${v.blink}|${v.paperLift}|${v.pile ?? 0}|${v.count ?? 0}`
    let s = this.cache.get(key)
    if (!s) {
      s = parseSprite(furnitureRows(f.kind, f.w, f.h, v), this.pal)
      this.cache.set(key, s)
    }
    return s
  }
}
