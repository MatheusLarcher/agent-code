/**
 * A ida ao quadro de um personagem — PURO (sem three, relógio pelo `dt`). A
 * coreografia (board/boardChoreo.ts) monta uma TAREFA (`Errand`): paradas
 * diante de uma coluna, do bloquinho (PAD) ou do cesto (BIN), cada uma com
 * gestos em sequência. Um gesto com `fire` é o instante em que o papel muda
 * de verdade na parede (quem anima lê `stop.fired` e aplica o cartão).
 *
 * Quem pode ir: o agente principal (uma saída curta dentro do modo `work`; ao
 * voltar senta e retoma o gesto da ferramenta) e o PO (`fixed`, volta ao lugar
 * dele). Permissão pendente, festa do apagão, fila do café ou porta: a tarefa
 * é abortada (`state = 'aborted'`) e o papel desliza sozinho.
 *
 * Lugar ocupado diante da coluna (outro personagem): espera ao lado (`wait`)
 * até liberar — a reserva é a mesma dos outros POIs.
 */
import { goDesk, goStand, lookAt, setAction, stay, type Brain, type BrainWorld, type Gait, type PropKind } from './brainBody'
import type { RoomFurniture } from './furniture'
import type { PoiBook } from './nav'
import type { Action } from './poses'

/** Colunas 0..2; o bloquinho e o cesto. */
export const PAD = -1
export const BIN = 3

export interface ErrandBeat {
  action: Action
  dur: number
  /** O que fica na mão durante o gesto (e depois dele, até o próximo). */
  prop: PropKind | null
  /** No fim deste gesto o papel muda na parede. */
  fire?: boolean
}

export interface ErrandStop {
  col: number
  beats: ErrandBeat[]
  /** O passo da viagem a que a parada pertence (a fala dele). */
  step: number
  fired: boolean
}

export type ErrandState = 'go' | 'wait' | 'act' | 'done' | 'aborted'

export interface Errand {
  stops: ErrandStop[]
  idx: number
  beat: number
  t: number
  gait: Gait
  state: ErrandState
}

/** Onde ficar diante de uma parada e para onde olhar. */
export interface BoardSpot {
  x: number
  z: number
  yaw: number
  lx: number
  ly: number
  lz: number
}

/** O mundo do quadro (Crowd): o lugar de cada parada, com reserva nas colunas. */
export interface BoardWorld {
  /** Reserva e devolve o lugar da parada; false se a coluna está ocupada por outro (out = ao lado, para esperar). */
  boardSpot(b: Brain, col: number, out: BoardSpot): boolean
}

export function newErrand(stops: ErrandStop[], gait: Gait): Errand {
  return { stops, idx: 0, beat: 0, t: 0, gait, state: 'go' }
}

/** O personagem não pode (mais) estar no quadro. */
export function errandBlocked(b: Brain): boolean {
  if (!b.visible || b.party !== null || b.puppet || b.phase === 'waiting-permission' || b.usageOut) return true
  return b.mode === 'permission' || b.mode === 'queue' || b.mode === 'leave' || b.mode === 'away' || b.mode === 'party'
}

/**
 * Volta: o principal senta na mesa (o modo `work` retoma o gesto da ferramenta; trabalhando, volta
 * correndo); o PO volta ao lugar.
 */
function goBack(b: Brain): void {
  b.prop = null
  b.look = 'none'
  if (b.mode === 'work' || b.mode === 'back' || (b.mode === 'sleep' && b.desk)) goDesk(b, b.phase === 'working' ? 'run' : 'walk')
  else if (b.mode === 'fixed') goStand(b, b.home.x, b.home.z, b.home.yaw, 'walk')
  else stay(b)
}

const spot: BoardSpot = { x: 0, z: 0, yaw: 0, lx: 0, ly: 0, lz: 0 }

/** Um passo da tarefa (no lugar do modo). Sem alocação. */
export function runErrand(b: Brain, dt: number, w: BrainWorld & BoardWorld): void {
  const e = b.errand
  if (!e || e.state === 'done' || e.state === 'aborted') return
  if (errandBlocked(b)) {
    e.state = 'aborted'
    w.release(b)
    b.prop = null
    // O novo modo (permissão, fila, festa…) já tem o seu objetivo; no `work`, quem refaz é a volta à mesa.
    if (b.mode === 'work') goBack(b)
    return
  }
  const stop = e.stops[e.idx]
  if (!stop) {
    e.state = 'done'
    w.release(b)
    goBack(b)
    return
  }
  const free = w.boardSpot(b, stop.col, spot)
  // Quem trabalha não fica esperando a coluna liberar: desiste (o resto desliza com o selo) e volta à mesa.
  if (!free && b.role !== 'fixed' && b.phase === 'working') {
    e.state = 'aborted'
    w.release(b)
    goBack(b)
    return
  }
  if (e.state === 'go' || e.state === 'wait') {
    e.state = free ? 'go' : 'wait'
    goStand(b, spot.x, spot.z, spot.yaw, e.gait)
    if (!b.arrived) {
      setAction(b, 'none')
      b.look = 'none'
      return
    }
    lookAt(b, spot.lx, spot.ly, spot.lz)
    if (!free) {
      setAction(b, 'wait')
      return
    }
    e.state = 'act'
    e.beat = 0
    e.t = 0
  }
  const beat = stop.beats[e.beat]
  setAction(b, beat.action)
  b.prop = beat.prop
  e.t += dt
  if (e.t < beat.dur) return
  if (beat.fire) stop.fired = true
  e.t = 0
  if (++e.beat < stop.beats.length) return
  // Parada feita: solta a coluna e segue (o papel na mão continua na mão).
  w.release(b)
  e.idx++
  e.state = 'go'
}

/** O lugar de uma parada: a coluna (reservada no livro dos POIs), o bloquinho ou o cesto. Coluna ocupada: ao lado, para esperar. */
export function boardSpotIn(f: RoomFurniture | undefined, book: PoiBook, b: Brain, col: number, out: BoardSpot): boolean {
  if (!f) {
    Object.assign(out, { x: b.x, z: b.z, yaw: b.yaw, lx: b.x, ly: 1.3, lz: b.z - 1 })
    return true
  }
  const first = f.pois.find((p) => p.kind === 'board' && p.index === 0)
  const row = first ? first.z : f.board.bin.z
  if (col === PAD || col === BIN) {
    const t = col === PAD ? { x: f.board.pad.x, y: f.board.pad.y, z: f.board.pad.z } : { x: f.board.bin.x, y: 0.3, z: f.board.bin.z }
    const x = col === PAD ? t.x + 0.15 : t.x - 0.55
    const z = col === PAD ? row : t.z + 0.35
    const yaw = col === PAD ? (first?.yaw ?? 0) : Math.atan2(-(t.x - x), -(t.z - z))
    Object.assign(out, { x, z, yaw, lx: t.x, ly: t.y, lz: t.z })
    return true
  }
  const p = f.pois.find((q) => q.kind === 'board' && q.index === col)
  if (!p) return boardSpotIn(f, book, b, PAD, out)
  Object.assign(out, { x: p.x, z: p.z, yaw: p.yaw, lx: p.look.x, ly: p.look.y, lz: p.look.z })
  if (book.claim(p.id, b.key)) return true
  out.z = p.z + 0.7
  return false
}
