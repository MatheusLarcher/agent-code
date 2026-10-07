/**
 * O palco da coreografia: consome a fila de passos do quadro (boardSync.steps)
 * no lugar do deslize automático. Liga o agendador puro (boardChoreo.ts) aos
 * cérebros (a tarefa `errand` de brainBoard.ts), à parede (o cartão muda no
 * instante em que o personagem prende o papel), aos balões e aos selos.
 *
 *   push(steps)   passos novos (o sync acabou de ler);
 *   tick(now)     ~4×/s: começa viagens, aplica o que foi preso, fala, encerra;
 *   flush()       tudo direto (aba escondida, volta da pausa, dispose);
 *   cardOf(key)   o cartão do balão do quadro de um personagem (o clique abre).
 *
 * Os dados ficam na mão do host (EngineBoard): quem pode ir, aplicar no
 * espelho, falar e pôr o selo. Sem o host vivo (aba escondida), tudo direto.
 *
 * Um quadro na parede, um projeto por vez: passo de projeto que NÃO está na
 * parede espera (estacionado, por projeto, em ordem de chegada). Com o palco
 * livre, o quadro troca para o próximo projeto (`host.visit`), a coreografia
 * dele roda, segura VISIT_HOLD_MS e volta (`visit(null)`). Estacionado mais que
 * LAG_MS (ou visita recusada pelo filtro) vai direto ao espelho.
 */
import { SPEED, type Brain } from '../brainBody'
import { errandBlocked, visitSpotOf, type BoardSpot } from '../brainBoard'
import { stepLine } from './boardLines'
import { BoardChoreo, LAG_MS, type Slide, type Trip, type VisitPlan } from './boardChoreo'
import type { BoardStep } from './boardModel'

/** A fala do quadro fica pelo menos isto (ms). */
export const SAY_MIN_MS = 4_000
/** Acabada a coreografia de um projeto visitado, o quadro fica nele mais isto (ms) antes de voltar. */
export const VISIT_HOLD_MS = 4_000
/** A visita do PO: o caminho planejado mais 10% (curvas, arrancadas)… */
const PATH_SLACK = 1.1
/** …ou, sem a grade de navegação, a reta vezes isto (o caminho desvia das ilhas). */
const STRAIGHT_SLACK = 1.3

export interface StageHost {
  brain(key: string): Brain | undefined
  /** Distância (m) do personagem até o quadro da sala dele; null sem sala. */
  boardDistance(b: Brain): number | null
  /** O caminho de verdade (m) do PO até (x, z) e de lá até o quadro (visitPath.ts); sem isto, a reta com folga. */
  visitPath?(po: Brain, x: number, z: number): number | null
  /** Animar agora? (aba à vista, sem pausa). */
  live(): boolean
  /** Sala no escuro ou festa do apagão: ninguém vai ao quadro. */
  dark(roomId: string): boolean
  fromColumn(s: BoardStep): number | null
  /** A parede ainda deve o real deste cartão (false: já está no lugar, nada a animar). */
  differs(s: BoardStep): boolean
  /** Aplica o cartão na parede (desliza ao lugar novo). */
  apply(roomId: string, cardId: string): void
  /** O balão do quadro do personagem (null tira). */
  say(key: string, text: string | null, convId: string): void
  seal(roomId: string, cardId: string, text: string, user: boolean): void
  /** O usuário arrastou este cartão no 3D há pouco (o passo dele não reanima nem leva selo). */
  draggedHere(cardId: string): boolean
  /** O projeto que está na parede agora. */
  wall(): string | null
  /** Põe o projeto na parede para a coreografia dele (null volta ao de antes); false se não pode (o filtro). */
  visit(projectId: string | null): boolean
}

interface Live {
  trip: Trip
  fired: Set<number>
  said: number
}

export class BoardStage {
  readonly choreo: BoardChoreo
  private readonly live = new Map<string, Live>()
  /** Personagem → até quando o balão fica, e o cartão dele. */
  private readonly speaking = new Map<string, { until: number; cardId: string | null; convId: string }>()
  /** Passos de projetos fora da parede, esperando a vez (ordem de chegada). */
  private readonly parked = new Map<string, { steps: BoardStep[]; since: number }>()
  private visiting: string | null = null
  /** Até quando o quadro segura o projeto visitado (0: a coreografia dele ainda corre). */
  private holdUntil = 0

  constructor(
    private readonly host: StageHost,
    private readonly clock: () => number = () => Date.now()
  ) {
    this.choreo = new BoardChoreo(clock)
  }

  push(steps: readonly BoardStep[]): void {
    if (!this.host.live()) {
      for (const s of steps) this.host.apply(s.roomId, s.cardId)
      return
    }
    // Papel já no lugar (arrasto no 3D, atraso já aplicado): nada reanima.
    const todo = steps.filter((s) => this.host.differs(s))
    for (const s of steps) if (!todo.includes(s)) this.host.apply(s.roomId, s.cardId)
    // Projeto fora da parede: espera a vez dele.
    const wall = this.host.wall()
    const now = this.clock()
    for (const s of todo) {
      if (s.roomId === wall) continue
      const p = this.parked.get(s.roomId)
      if (p) p.steps.push(s)
      else this.parked.set(s.roomId, { steps: [s], since: now })
    }
    this.slide(this.choreo.push(todo.filter((s) => s.roomId === wall)))
    this.tick()
  }

  /**
   * A vez dos projetos estacionados: com o palco livre, o quadro troca para o
   * próximo; acabada a coreografia dele, segura VISIT_HOLD_MS e volta.
   */
  private visits(now: number): boolean {
    let changed = false
    for (const [id, p] of this.parked) {
      if (now - p.since <= LAG_MS) continue
      this.parked.delete(id)
      for (const s of p.steps) this.host.apply(s.roomId, s.cardId)
      changed = true
    }
    if (this.live.size > 0 || this.choreo.active.length > 0 || this.choreo.waiting > 0) {
      this.holdUntil = 0
      return changed
    }
    if (this.visiting && this.holdUntil === 0) {
      this.holdUntil = now + VISIT_HOLD_MS
      return changed
    }
    if (this.visiting && now < this.holdUntil) return changed
    for (const [id, p] of this.parked) {
      this.parked.delete(id)
      const todo = p.steps.filter((s) => this.host.differs(s))
      if (todo.length === 0) continue
      if (!this.host.visit(id)) {
        for (const s of todo) this.host.apply(s.roomId, s.cardId)
        changed = true
        continue
      }
      this.visiting = id
      this.holdUntil = 0
      this.slide(this.choreo.push(todo))
      return true
    }
    if (this.visiting) {
      this.visiting = null
      this.host.visit(null)
      changed = true
    }
    return changed
  }

  private slide(list: readonly Slide[]): void {
    for (const sl of list) {
      const { step } = sl
      const here = sl.user && this.host.draggedHere(step.cardId)
      this.host.apply(step.roomId, step.cardId)
      if (sl.seal && !here) this.host.seal(step.roomId, step.cardId, sl.seal, sl.user)
    }
  }

  private readonly ctx = {
    available: (key: string, roomId: string): boolean => {
      const b = this.host.brain(key)
      if (!b || b.projectId !== roomId || this.host.dark(roomId) || errandBlocked(b)) return false
      // Trabalhando e ainda a caminho (voltando de uma ida): o que chega desliza, não emenda outra viagem.
      if (b.role === 'desk' && b.phase === 'working' && !b.arrived) return false
      return key.startsWith('po:') ? b.role === 'fixed' : b.role === 'desk'
    },
    walkS: (key: string): number => {
      const b = this.host.brain(key)
      const d = b ? this.host.boardDistance(b) : null
      // Levantar da cadeira e virar: ~1 s além da caminhada.
      return d === null ? 0 : d / SPEED.walk + (b && b.sit > 0 ? 1 : 0)
    },
    fromColumn: (s: BoardStep): number | null => this.host.fromColumn(s),
    hurry: (key: string): boolean => {
      const b = this.host.brain(key)
      return !!b && b.role === 'desk' && b.phase === 'working'
    },
    // A visita do PO: da posição dele até o lado da cadeira do agente, e da mesa até o quadro.
    visit: (key: string, target: string): VisitPlan | null => {
      const po = this.host.brain(key)
      const t = this.host.brain(target)
      if (!po || !t || !visitSpotOf(t, this.desk)) return null
      const { x, z } = this.desk
      let m: number | null
      if (this.host.visitPath) {
        const path = this.host.visitPath(po, x, z)
        m = path === null ? null : path * PATH_SLACK
      } else {
        const back = this.host.boardDistance(t)
        m = back === null ? null : (Math.hypot(x - po.x, z - po.z) + back) * STRAIGHT_SLACK
      }
      return m === null ? null : { target, at: { ...this.desk }, walkS: m / SPEED.walk }
    }
  }

  /** O lugar da visita (rascunho da conta, sem alocar). */
  private readonly desk: BoardSpot = { x: 0, z: 0, yaw: 0, lx: 0, ly: 0, lz: 0 }

  /** true se algo mudou (a cena pede um quadro). */
  tick(now = this.clock()): boolean {
    if (!this.host.live()) return this.flush() > 0
    // A vez de um projeto estacionado começa antes: a viagem dele já sai neste tique.
    let changed = this.visits(now)
    const { trips, slides } = this.choreo.next(this.ctx)
    if (slides.length > 0) changed = true
    this.slide(slides)
    for (const trip of trips) {
      const b = this.host.brain(trip.key)
      if (!b) {
        this.abort(trip)
        continue
      }
      b.errand = trip.errand
      this.live.set(trip.key, { trip, fired: new Set(), said: -1 })
      changed = true
    }
    for (const lv of [...this.live.values()]) if (this.follow(lv, now)) changed = true
    for (const [key, sp] of this.speaking) {
      if (now < sp.until || this.live.has(key)) continue
      this.speaking.delete(key)
      this.host.say(key, null, sp.convId)
      changed = true
    }
    return changed
  }

  /** Acompanha uma viagem: aplica o que foi preso, fala o passo atual, encerra. */
  private follow(lv: Live, now: number): boolean {
    const { trip } = lv
    const b = this.host.brain(trip.key)
    const e = trip.errand
    if (!b || b.errand !== e || e.state === 'aborted' || now - trip.startedAt > LAG_MS) {
      this.abort(trip, b)
      return true
    }
    let changed = false
    e.stops.forEach((stop, i) => {
      if (!stop.fired || lv.fired.has(i)) return
      lv.fired.add(i)
      const s = trip.steps[stop.step]
      this.host.apply(s.roomId, s.cardId)
      changed = true
    })
    const cur = e.stops[e.idx]
    // A visita: o agente saiu da mesa enquanto o PO ia — ele segue direto ao quadro.
    if (cur?.visit && !visitSpotOf(this.host.brain(cur.visit), this.desk)) cur.visit = undefined
    if (cur && e.state === 'act' && cur.step !== lv.said) {
      lv.said = cur.step
      const s = trip.steps[cur.step]
      const line = trip.lines[cur.step]
      if (line) this.speak(trip.key, line, s.cardId, s.convId, now)
      changed = true
    }
    if (e.state === 'done') {
      this.finish(trip, b)
      // A última fala ainda acompanha a volta um pouco.
      const sp = this.speaking.get(trip.key)
      if (sp) sp.until = Math.max(sp.until, now + SAY_MIN_MS / 2)
      if (trip.summary) this.speak(trip.key, trip.summary, null, trip.steps[0].convId, now)
      changed = true
    }
    return changed
  }

  private speak(key: string, text: string, cardId: string | null, convId: string, now: number, ms = SAY_MIN_MS): void {
    this.speaking.set(key, { until: now + ms, cardId, convId })
    this.host.say(key, text, convId)
  }

  /** Fala de fora da coreografia (o resumo "desde que você saiu"): o mesmo balão, por `ms`. */
  announce(key: string, text: string, convId: string, ms: number): void {
    this.speak(key, text, null, convId, this.clock(), ms)
  }

  /** Encerra a viagem: o que não foi preso vai direto (sem replay). */
  private finish(trip: Trip, b: Brain | undefined): void {
    const lv = this.live.get(trip.key)
    this.live.delete(trip.key)
    this.choreo.end(trip.key)
    if (b && b.errand === trip.errand) b.errand = null
    trip.steps.forEach((s, i) => {
      const fired = trip.errand.stops.some((st, k) => st.step === i && st.fired && (lv?.fired.has(k) ?? false))
      if (!fired) this.host.apply(s.roomId, s.cardId)
    })
  }

  /** Abortada (permissão, apagão, sumiu, passou do prazo): o resto desliza com o selo. */
  private abort(trip: Trip, b?: Brain): void {
    const lv = this.live.get(trip.key)
    if (b && b.errand === trip.errand && trip.errand.state !== 'done') trip.errand.state = 'aborted'
    const pending = trip.steps.filter((_, i) => !trip.errand.stops.some((st, k) => st.step === i && st.fired && (lv?.fired.has(k) ?? false)))
    this.finish(trip, b)
    for (const s of pending) {
      const line = stepLine(s, false)
      if (line) this.host.seal(s.roomId, s.cardId, line, false)
    }
  }

  /** Tudo direto: a fila, as viagens em curso e os balões. Devolve quantos passos aplicou. */
  flush(): number {
    let n = 0
    for (const lv of this.live.values()) {
      const b = this.host.brain(lv.trip.key)
      if (b && b.errand === lv.trip.errand) {
        lv.trip.errand.state = 'aborted'
        b.errand = null
        b.prop = null
      }
    }
    this.live.clear()
    for (const s of this.choreo.flush()) {
      this.host.apply(s.roomId, s.cardId)
      n++
    }
    for (const p of this.parked.values()) {
      for (const s of p.steps) this.host.apply(s.roomId, s.cardId)
      n += p.steps.length
    }
    this.parked.clear()
    if (this.visiting) {
      this.visiting = null
      this.holdUntil = 0
      this.host.visit(null)
    }
    for (const [key, sp] of this.speaking) this.host.say(key, null, sp.convId)
    this.speaking.clear()
    return n
  }

  /** O cartão do balão do quadro do personagem (null se o balão não é do quadro). */
  cardOf(key: string): string | null {
    return this.speaking.get(key)?.cardId ?? null
  }

  /** O personagem está numa ida ao quadro. */
  busy(key: string): boolean {
    return this.live.has(key)
  }
}
