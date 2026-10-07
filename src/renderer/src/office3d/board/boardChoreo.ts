/**
 * A coreografia do quadro — PURA (sem three, sem DOM; relógio injetado). Recebe
 * os passos com autor (boardModel.ts) e decide QUEM anima cada um:
 *
 *   agent         o agente principal da conversa dona (`conv:<convId>`);
 *   po / system   o PO da sala (`po:<sala>`); a fala do sistema é regra;
 *   user / null   ninguém: o papel desliza (o do usuário com o selo "Você").
 *
 * Sem personagem disponível (conversa fora do escritório, PO desligado,
 * permissão pendente, apagão) o papel desliza com o SELO preso ao quadro, com
 * a mesma frase em terceira pessoa.
 *
 * Fila por personagem, na ordem real (`at`). Uma VIAGEM leva todas as mudanças
 * pendentes dele (fecha a 2 e abre a 3: uma ida só), até TRIP_CAP; o excedente
 * é aplicado direto e vira uma fala-resumo. Invariante: o 3D nunca fica mais
 * de LAG_MS diferente do real — se a ida não cabe, o papel desliza sozinho.
 * Com fila (mais de um passo) ou no meio do trabalho, corre; trabalhando, a ida
 * leva no máximo TRIP_CAP_BUSY passos e só sai de quem está sentado na mesa
 * (nada de emendar viagens: o que chega na volta desliza). Mesmo cartão por autores diferentes: o
 * segundo espera a viagem do primeiro acabar.
 *
 * A visita do PO: antes do quadro, ele passa na mesa do agente principal da conversa do primeiro
 * passo (uma visita só por viagem) e conversa VISIT_S. Só se o agente está na mesa e se a visita
 * cabe no prazo sem tirar nenhum passo da viagem; senão, vai direto ao quadro.
 */
import { SPEED, type Gait } from '../brainBody'
import { BIN, DESK, newErrand, PAD, type BoardSpot, type Errand, type ErrandBeat, type ErrandStop } from '../brainBoard'
import { principalKey } from '../../office/adapter/model'
import { stepLine, summaryLine, USER_SEAL } from './boardLines'
import { columnIndex, type BoardStep } from './boardModel'

/** Até tantos passos animados por viagem; o resto vai direto (com a fala-resumo). */
export const TRIP_CAP = 4
/** Quem leva no meio do trabalho vai e volta logo: até tantos passos, correndo e com os gestos curtos. */
export const TRIP_CAP_BUSY = 2
/** O 3D nunca fica mais que isto diferente do real (ms) — o mesmo MAX_LAG_MS do espelho. */
export const LAG_MS = 15_000
/** Quanto um passo leva no quadro (s), contando a andança entre as colunas. */
export const STEP_S = 5
/** Com fila (correndo, gestos curtos): cabe o TRIP_CAP inteiro no prazo. */
export const STEP_RUN_S = 3.4
/** Correndo, os gestos duram isto do normal. */
const QUICK = 0.6
/** A conversa do PO na mesa do agente (s, no ritmo normal). */
export const VISIT_S = 1.2

export type Motion = 'write' | 'move' | 'complete' | 'rename' | 'point' | 'trash' | 'restore'

export function motionOf(s: BoardStep): Motion {
  switch (s.kind) {
    case 'new':
      return 'write'
    case 'moved':
      return s.toStatus === 'completed' ? 'complete' : 'move'
    case 'renamed':
      return 'rename'
    case 'justified':
      return 'point'
    case 'removed':
      return 'trash'
    case 'restored':
      return 'restore'
  }
}

/** Quem leva o papel do passo (null = ninguém: desliza). */
export function performerOf(s: BoardStep): string | null {
  if (s.actor === 'agent') return principalKey(s.convId)
  if (s.actor === 'po' || s.actor === 'system') return `po:${s.roomId}`
  return null
}

const beatOf = (action: ErrandBeat['action'], dur: number, prop: ErrandBeat['prop'] = null, fire = false): ErrandBeat => ({ action, dur, prop, fire })

/** As paradas de um passo. `from` = coluna em que o papel está hoje na parede (null se não está). */
export function stopsFor(s: BoardStep, from: number | null, step: number, quick = false): ErrandStop[] {
  // Com fila, os gestos encurtam (~3,4 s por passo) para caber TRIP_CAP no prazo.
  const q = quick ? QUICK : 1
  const beat = (a: ErrandBeat['action'], d: number, p: ErrandBeat['prop'] = null, f = false): ErrandBeat => beatOf(a, d * q, p, f)
  const to = s.toStatus ? columnIndex(s.toStatus) : (from ?? 0)
  const stop = (col: number, beats: ErrandBeat[]): ErrandStop => ({ col, beats, step, fired: false })
  const pickUp = (col: number): ErrandStop => stop(col, [beat('unpin', 1), beat('idle', 0.3, 'note')])
  const pin = (extra: ErrandBeat[] = [beat('admire', 1)]): ErrandStop => stop(to, [beat('stick', 1.1, 'note', true), ...extra])
  switch (motionOf(s)) {
    case 'write':
      return [stop(PAD, [beat('scribble', 1.6, 'note')]), pin()]
    case 'move':
      return from === null || from === to ? [stop(to, [beat('readBoard', 0.8), beat('stick', 1.1, null, true), beat('admire', 1)])] : [pickUp(from), pin()]
    case 'complete':
      return from === null || from === to
        ? [stop(to, [beat('stamp', 0.9, null, true), beat('admire', 1)])]
        : [pickUp(from), pin([beat('stamp', 0.9), beat('admire', 0.8)])]
    case 'rename':
      return [stop(from ?? to, [beat('scribble', 2, null, true), beat('admire', 1)])]
    case 'point':
      return [stop(from ?? to, [beat('point', 0.2, null, true), beat('point', 2.8)])]
    case 'trash':
      return [pickUp(from ?? 0), stop(BIN, [beat('crumple', 1.2, 'note', true), beat('idle', 0.5)])]
    case 'restore':
      return [stop(BIN, [beat('grabBook', 0.9), beat('scribble', 0.8, 'note')]), pin()]
  }
}

/** A visita possível: quem visitar, onde ficar e quanto custa andando (s), de onde o PO está até a mesa e dela até o quadro. */
export interface VisitPlan {
  target: string
  at: BoardSpot
  walkS: number
}

/** A parada da visita à mesa do agente (sem fala e sem mudar papel). */
export function visitStop(v: VisitPlan, quick = false): ErrandStop {
  return { col: DESK, beats: [beatOf('talk', VISIT_S * (quick ? QUICK : 1))], step: -1, fired: false, visit: v.target, at: { ...v.at } }
}

export interface ChoreoCtx {
  /** O personagem está no escritório, na sala do passo, e pode ir ao quadro agora. */
  available(key: string, roomId: string): boolean
  /** Andando, quantos segundos até o quadro (só a ida). */
  walkS(key: string): number
  /** A coluna do papel na parede agora (null se não está). */
  fromColumn(s: BoardStep): number | null
  /** Está no meio do trabalho: a ida é curta (TRIP_CAP_BUSY, correndo, gestos curtos). */
  hurry?(key: string): boolean
  /** A visita de `key` (o PO) ao agente `target` antes do quadro; null se o agente não está na mesa. */
  visit?(key: string, target: string): VisitPlan | null
}

export interface Trip {
  key: string
  roomId: string
  /** O agente visitado antes do quadro (null: direto ao quadro). */
  visit: string | null
  steps: BoardStep[]
  /** A fala de cada passo (primeira pessoa). */
  lines: Array<string | null>
  errand: Errand
  /** "+5 mudanças: …" quando passou do teto (dito no fim). */
  summary: string | null
  startedAt: number
}

/** Um passo aplicado sem personagem: o papel desliza; `seal` = o texto preso ao quadro. */
export interface Slide {
  step: BoardStep
  seal: string | null
  user: boolean
}

interface Queued {
  step: BoardStep
  at: number
}

const slide = (step: BoardStep, sealed: boolean): Slide => ({
  step,
  seal: step.actor === 'user' ? USER_SEAL : sealed ? stepLine(step, false) : null,
  user: step.actor === 'user'
})

export class BoardChoreo {
  private readonly queues = new Map<string, Queued[]>()
  private readonly trips = new Map<string, Trip>()

  constructor(private readonly clock: () => number = () => Date.now()) {}

  /** Passos novos: os sem personagem já saem deslizando; o resto entra na fila de quem leva. */
  push(steps: readonly BoardStep[]): Slide[] {
    const now = this.clock()
    const out: Slide[] = []
    for (const s of steps) {
      const key = performerOf(s)
      if (!key) {
        out.push(slide(s, false))
        continue
      }
      const q = this.queues.get(key)
      if (q) q.push({ step: s, at: now })
      else this.queues.set(key, [{ step: s, at: now }])
    }
    return out
  }

  /** O cartão está numa viagem em curso de outro personagem, ou outro tem um passo mais antigo dele na fila. */
  private locked(s: BoardStep, key: string): boolean {
    for (const t of this.trips.values()) if (t.key !== key && t.steps.some((x) => x.cardId === s.cardId)) return true
    for (const [k, q] of this.queues) if (k !== key && q.some((x) => x.step.cardId === s.cardId && x.step.at < s.at)) return true
    return false
  }

  /** Começa as viagens de quem está livre; quem não pode ir desliza com selo. */
  next(ctx: ChoreoCtx): { trips: Trip[]; slides: Slide[] } {
    const now = this.clock()
    const trips: Trip[] = []
    const slides: Slide[] = []
    for (const [key, q] of [...this.queues]) {
      if (this.trips.has(key) || q.length === 0) continue
      if (!ctx.available(key, q[0].step.roomId)) {
        for (const x of q) slides.push(slide(x.step, true))
        this.queues.delete(key)
        continue
      }
      const take = q.filter((x) => !this.locked(x.step, key))
      if (take.length === 0) continue
      this.queues.set(key, q.filter((x) => !take.includes(x)))
      const age = (now - Math.min(...take.map((x) => x.at))) / 1000
      const budget = LAG_MS / 1000 - age
      const fit = (walk: number, run: boolean): number => Math.floor((budget - walk) / (run ? STEP_RUN_S : STEP_S))
      const walk = ctx.walkS(key)
      const hurry = ctx.hurry?.(key) ?? false
      // `lead` = andando até a 1ª parada do quadro (s); `extra` = gestos antes dela (a conversa da visita).
      const plan = (lead: number, extra = 0): { gait: Gait; k: number } => {
        const cost = (run: boolean): number => (run ? (lead * SPEED.walk) / SPEED.run + extra * QUICK : lead + extra)
        let gait: Gait = take.length > 1 || hurry ? 'run' : 'walk'
        let k = fit(cost(gait === 'run'), gait === 'run')
        if (gait === 'walk' && k < 1) {
          gait = 'run'
          k = fit(cost(true), true)
        }
        return { gait, k: Math.min(k, hurry ? TRIP_CAP_BUSY : TRIP_CAP, take.length) }
      }
      const direct = plan(walk)
      // A visita do PO só entra se couber sem tirar nenhum passo da viagem.
      const v = key.startsWith('po:') && direct.k > 0 ? (ctx.visit?.(key, principalKey(take[0].step.convId)) ?? null) : null
      const viaDesk = v ? plan(v.walkS, VISIT_S) : null
      const visit = v && viaDesk && viaDesk.k === direct.k ? v : null
      const { gait, k } = visit && viaDesk ? viaDesk : direct
      if (k <= 0) {
        for (const x of take) slides.push(slide(x.step, true))
        continue
      }
      const ride = take.slice(0, k).map((x) => x.step)
      const rest = take.slice(k).map((x) => x.step)
      for (const s of rest) slides.push(slide(s, false))
      const stops = ride.flatMap((s, i) => stopsFor(s, ctx.fromColumn(s), i, gait === 'run'))
      if (visit) stops.unshift(visitStop(visit, gait === 'run'))
      const trip: Trip = {
        key,
        roomId: ride[0].roomId,
        visit: visit?.target ?? null,
        steps: ride,
        lines: ride.map((s) => stepLine(s, true)),
        errand: newErrand(stops, gait),
        summary: rest.length > 0 ? summaryLine(rest.map(motionOf)) : null,
        startedAt: now
      }
      this.trips.set(key, trip)
      trips.push(trip)
    }
    for (const [key, q] of this.queues) if (q.length === 0) this.queues.delete(key)
    return { trips, slides }
  }

  /** A viagem acabou (ou foi abortada): o personagem fica livre. */
  end(key: string): Trip | undefined {
    const t = this.trips.get(key)
    this.trips.delete(key)
    return t
  }

  trip(key: string): Trip | undefined {
    return this.trips.get(key)
  }

  get active(): Trip[] {
    return [...this.trips.values()]
  }

  /** Quantos passos esperam um personagem. */
  get waiting(): number {
    let n = 0
    for (const q of this.queues.values()) n += q.length
    return n
  }

  /** Tudo direto (aba escondida, volta da pausa): devolve o que estava na fila e esquece as viagens. */
  flush(): BoardStep[] {
    const out: BoardStep[] = []
    for (const q of this.queues.values()) for (const x of q) out.push(x.step)
    for (const t of this.trips.values()) out.push(...t.steps)
    this.queues.clear()
    this.trips.clear()
    return out
  }
}
