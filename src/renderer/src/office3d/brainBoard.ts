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
 *
 * A visita (DESK): antes do quadro, o PO passa na mesa do agente da conversa,
 * em pé ao lado da cadeira dele, e conversa um instante. Agente fora da mesa
 * quando o PO chega: a parada é pulada, sem esperar.
 */
import { goDesk, goStand, lookAt, setAction, stay, type Brain, type BrainWorld, type Gait, type PropKind } from './brainBody'
import { chairSide, type RoomFurniture } from './furniture'
import type { PoiBook } from './nav'
import { deskPoint, SEAT_FRONT } from './officePlan'
import type { Action } from './poses'

/** Colunas 0..2; o bloquinho e o cesto; a mesa do agente visitado; a bandeja da fila (a folha que o PO entrega). */
export const PAD = -1
export const BIN = 3
export const DESK = -2
export const TRAY = -3
/** Na mesa: o agente está a menos disto (m) do assento dele (sentado ou chegando). */
const AT_DESK_M = 1.2
/** Altura da cabeça de quem está sentado (para onde o PO olha na visita). */
const SEATED_HEAD_Y = 1.15

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
  /** O passo da viagem a que a parada pertence (a fala dele); −1 na visita (sem fala). */
  step: number
  fired: boolean
  /** Na parada DESK: a chave do agente visitado (o palco tira quando ele sai da mesa: a parada é pulada). */
  visit?: string
  /** Fora do quadro (DESK, TRAY): onde ficar, calculado ao planejar a ida (visitSpotOf, a bandeja). */
  at?: BoardSpot
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

/**
 * Onde o PO fica na visita: em pé ao lado da cadeira do agente (o lado de pé da mesa), virado para
 * ele e olhando a cabeça dele. false se o agente não pode receber visita agora: fora do escritório,
 * sem mesa, longe dela (`atDesk`; a entrega da folha vai à mesa mesmo com ele ainda chegando), numa
 * ida ao quadro ou num modo que tira do lugar (permissão, fila, festa…).
 */
export function visitSpotOf(t: Brain | undefined, out: BoardSpot, atDesk = true): boolean {
  if (!t || !t.desk || t.outside || t.errand || errandBlocked(t)) return false
  const seat = deskPoint(t.desk, 0, SEAT_FRONT)
  if (atDesk && Math.hypot(t.x - seat.x, t.z - seat.z) > AT_DESK_M) return false
  const s = chairSide(t.desk)
  Object.assign(out, { x: s.x, z: s.z, yaw: Math.atan2(-(seat.x - s.x), -(seat.z - s.z)), lx: seat.x, ly: SEATED_HEAD_Y, lz: seat.z })
  return true
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
  // A visita: o agente saiu da mesa no caminho — segue para a próxima parada.
  if (stop.col === DESK && !(stop.visit && stop.at)) {
    e.idx++
    e.state = 'go'
    return
  }
  // Fora do quadro (a mesa visitada, a bandeja da fila): o lugar vem na parada, sem reserva.
  if (stop.at) Object.assign(spot, stop.at)
  const free = !!stop.at || w.boardSpot(b, stop.col, spot)
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
