/**
 * A VISITA do Scrum Master: numa cobrança do diário (marco ≥150) ou num corte
 * (`parou`) de uma conversa, o SM da sala dela (`scrum:<sala>`) vai até a mesa
 * do agente (o caminho da visita, brainBoard.ts), fala o começo da cobrança no
 * balão e volta ao lugar. Envio parado por ele: fica na mesa até a retomada (o
 * agente volta a trabalhar). NÃO passa pela coreografia do quadro
 * (boardChoreo.ts): é uma tarefa só com a parada DESK.
 *
 * Pula quando o agente não está na mesa ou outro personagem já está ao lado
 * dele (lugar ocupado). SM fora, ocupado ou bloqueado, aba escondida, apagão:
 * o pedido espera um pouco (PENDING_MS; o corte, HOLD_PENDING_MS) e some.
 * Ao abrir o app, os envios ainda parados pelo SM voltam a ter o SM na mesa.
 */
import type { AgentCodeApi } from '@shared/api'
import type { ScrumChangedMsg, ScrumDecisao } from '@shared/scrumPanel'
import { principalKey } from '../../office/adapter/model'
import { goStand, type Brain } from '../brainBody'
import { DESK, errandBlocked, newErrand, visitSpotOf, type BoardSpot, type Errand, type ErrandBeat } from '../brainBoard'
import { PRIORITY, type Quip } from '../quips'

/** Conversando ao lado da mesa (s) antes de voltar. */
export const VISIT_TALK_S = 3.2
/** Uma visita que passa disto (ms) é encerrada (caminho preso). */
export const VISIT_MAX_MS = 60_000
/** O pedido que não pôde sair agora espera isto (ms); o do corte, mais (o app acabou de abrir). */
export const PENDING_MS = 15_000
export const HOLD_PENDING_MS = 90_000
/** Na mesa do parado: o agente trabalhando depois disto (ms) = retomado; o SM volta. */
export const HOLD_GRACE_MS = 8_000
/** O balão: o começo da cobrança. */
export const SAY_CHARS = 90
/** Demonstração: uma visita a cada (ms); a parada da demo dura (ms). */
export const DEMO_EVERY_MS = 18_000
export const DEMO_HOLD_MS = 20_000

const STOP_PREFIX = 'Scrum Master: '

export interface ScrumVisitReq {
  convId: string
  text: string
  /** O envio foi parado pelo SM: fica na mesa até a retomada. */
  hold: boolean
}

/** A visita que uma decisão do diário pede (null: nenhuma). Só a cobrança ≥150% e o corte. */
export function visitOf(d: ScrumDecisao): ScrumVisitReq | null {
  if (d.tipo === 'parou') return { convId: d.convId, text: `Parei o envio: ${stripStop(d.motivo ?? d.cobranca ?? 'etapa muito atrasada')}`, hold: true }
  const cobranca = d.tipo === 'cobrou' || (d.tipo === 'falha' && !!d.cobranca)
  if (!cobranca || typeof d.marco !== 'number' || d.marco < 150) return null
  return { convId: d.convId, text: d.cobranca ?? d.motivo ?? `A etapa passou de ${d.marco}% do prazo.`, hold: false }
}

const stripStop = (s: string): string => (s.startsWith(STOP_PREFIX) ? s.slice(STOP_PREFIX.length) : s)

/** O começo da fala: a primeira frase, até SAY_CHARS. */
export function sayText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const first = flat.split(/(?<=[.!?])\s/)[0] ?? flat
  return first.length <= SAY_CHARS ? first : `${first.slice(0, SAY_CHARS - 1).trimEnd()}…`
}

export interface ScrumVisitHost {
  brain(key: string): Brain | undefined
  brains(): Iterable<Brain>
  /** Animar agora? (aba à vista, sem pausa, luz acesa e sem festa). */
  live(): boolean
  say(key: string, quip: Quip | null): void
}

export interface ScrumVisitApi {
  onChanged(cb: (msg: ScrumChangedMsg) => void): () => void
  /** Os envios parados pelo SM agora (ao abrir o app). */
  stopped(): Promise<ScrumVisitReq[]>
}

/** O painel do app como fonte (null fora do Electron). */
export function appScrumVisitApi(): ScrumVisitApi | null {
  const api = (globalThis as { window?: { api?: Partial<Pick<AgentCodeApi, 'onScrumChanged' | 'scrumPanel'>> } }).window?.api
  const onChanged = api?.onScrumChanged
  const panel = api?.scrumPanel
  if (typeof onChanged !== 'function' || typeof panel !== 'function') return null
  return {
    onChanged: (cb) => onChanged(cb),
    stopped: async () => {
      const r = await panel()
      if (!r.ok) return []
      return r.snapshot.envios.filter((e) => e.estado === 'parado').map((e) => ({ convId: e.convId, text: `Parei o envio: ${stripStop(e.paradoMotivo ?? 'etapa muito atrasada')}`, hold: true }))
    }
  }
}

interface Visit {
  key: string
  target: string
  req: ScrumVisitReq
  errand: Errand
  startedAt: number
  spoke: boolean
  /** A volta já foi pedida (a parada encurtada): espera o fim da tarefa. */
  leaving: boolean
  demo: boolean
}

interface Pending {
  req: ScrumVisitReq
  at: number
  demo: boolean
}

const beat = (action: ErrandBeat['action'], dur: number): ErrandBeat => ({ action, dur, prop: null })

/** A tarefa: só a parada DESK; no corte, o último gesto não acaba (quem encerra é a retomada). */
export function visitErrand(target: string, at: BoardSpot, hold: boolean): Errand {
  const beats = hold ? [beat('talk', VISIT_TALK_S), beat('idle', Infinity)] : [beat('talk', VISIT_TALK_S), beat('idle', 0.6)]
  return newErrand([{ col: DESK, beats, step: -1, fired: false, visit: target, at: { ...at } }], 'walk')
}

const active = (e: Errand | null): e is Errand => !!e && e.state !== 'done' && e.state !== 'aborted'

export class ScrumVisits {
  private readonly visits = new Map<string, Visit>()
  private pending: Pending[] = []
  private readonly spot: BoardSpot = { x: 0, z: 0, yaw: 0, lx: 0, ly: 0, lz: 0 }
  private readonly off: () => void
  private demoNext: number | null = null
  private demoTurn = 0

  constructor(
    private readonly host: ScrumVisitHost,
    api: ScrumVisitApi | null,
    private readonly clock: () => number = () => Date.now()
  ) {
    this.off = api ? api.onChanged((m) => this.decision(m.decisao)) : () => {}
    void api
      ?.stopped()
      .then((list) => list.forEach((r) => this.push(r)))
      .catch(() => undefined)
  }

  /** Uma linha nova do diário (o evento scrumChanged). */
  decision(d: ScrumDecisao): void {
    const req = visitOf(d)
    if (req) this.push(req)
  }

  push(req: ScrumVisitReq, demo = false): void {
    this.pending = this.pending.filter((p) => p.req.convId !== req.convId)
    this.pending.push({ req, at: this.clock(), demo })
  }

  /** Demonstração: visitas falsas aos agentes da demo; desligar larga as delas. */
  setDemo(on: boolean): void {
    this.demoNext = on ? this.clock() + 4_000 : null
    if (on) return
    this.pending = this.pending.filter((p) => !p.demo)
    for (const v of [...this.visits.values()]) if (v.demo) this.leave(v)
  }

  /** O tique do motor. true se um balão mudou. */
  tick(now = this.clock()): boolean {
    let changed = false
    if (this.demoNext !== null && now >= this.demoNext) {
      this.demoNext = now + DEMO_EVERY_MS
      this.demoVisit()
    }
    if (this.pending.length > 0) changed = this.startPending(now) || changed
    for (const v of [...this.visits.values()]) changed = this.follow(v, now) || changed
    return changed
  }

  private startPending(now: number): boolean {
    let changed = false
    const keep: Pending[] = []
    for (const p of this.pending) {
      const r = this.start(p, now)
      if (r === 'wait' && now - p.at < (p.req.hold ? HOLD_PENDING_MS : PENDING_MS)) keep.push(p)
      if (r === 'started') changed = true
    }
    this.pending = keep
    return changed
  }

  /** Tenta começar a visita: 'skip' = não vai (lugar ocupado, já retomado); 'wait' = ainda não dá. */
  private start(p: Pending, now: number): 'started' | 'wait' | 'skip' {
    const target = principalKey(p.req.convId)
    const t = this.host.brain(target)
    if (!t?.projectId || !this.host.live()) return 'wait'
    // Ao abrir o app o agente pode já ter sido retomado: o corte velho não leva o SM à mesa.
    if (p.req.hold && t.phase === 'working' && now - p.at > HOLD_GRACE_MS) return 'skip'
    // A sala do projeto (o `roomId` do cérebro é o escritório inteiro).
    const key = `scrum:${t.projectId}`
    const sm = this.host.brain(key)
    if (!sm || sm.role !== 'fixed' || errandBlocked(sm)) return 'wait'
    const cur = this.visits.get(key)
    if (cur?.target === target && !cur.leaving) {
      // O mesmo agente de novo: só troca a fala (e passa a ficar, se agora é corte).
      if (p.req.hold && !cur.req.hold) cur.errand.stops[0].beats[1].dur = Infinity
      cur.req = p.req
      cur.spoke = false
      return 'started'
    }
    // Um corte novo tira o SM da mesa do parado anterior; uma cobrança espera a visita em curso acabar.
    if (cur && cur.req.hold && cur.errand.state === 'act') this.leave(cur)
    if (cur || sm.errand) return 'wait'
    if (this.occupied(target, key) || !visitSpotOf(t, this.spot)) return p.req.hold ? 'wait' : 'skip'
    const errand = visitErrand(target, this.spot, p.req.hold)
    sm.errand = errand
    this.visits.set(key, { key, target, req: p.req, errand, startedAt: now, spoke: false, leaving: false, demo: p.demo })
    return 'started'
  }

  /** Outro personagem já vai (ou está) ao lado da mesa de `target`. */
  private occupied(target: string, self: string): boolean {
    for (const b of this.host.brains()) {
      if (b.key === self || !active(b.errand)) continue
      const stop = b.errand.stops[b.errand.idx]
      if (stop?.visit === target) return true
    }
    return false
  }

  private follow(v: Visit, now: number): boolean {
    const sm = this.host.brain(v.key)
    if (!sm || sm.errand !== v.errand || !active(v.errand)) return this.end(v)
    const t = this.host.brain(v.target)
    let changed = false
    if (!v.spoke && v.errand.state === 'act') {
      v.spoke = true
      this.host.say(v.key, { text: sayText(v.req.text), kind: 'warn', icon: '⏱️', priority: PRIORITY.board, ttlMs: Infinity, convId: v.req.convId })
      changed = true
    }
    if (v.leaving) return changed
    // Agente saiu da mesa: a parada é pulada (ainda indo) ou encerrada (já na mesa).
    const away = !visitSpotOf(t, this.spot)
    const resumed = v.req.hold && !v.demo && !!t && t.phase === 'working' && now - v.startedAt > HOLD_GRACE_MS
    const demoDone = v.demo && v.req.hold && now - v.startedAt > DEMO_HOLD_MS
    const late = !v.req.hold && now - v.startedAt > VISIT_MAX_MS
    if (away || resumed || demoDone || late) this.leave(v)
    return changed
  }

  /** Encurta a parada: o fim natural da tarefa leva o SM de volta ao lugar (goBack). */
  private leave(v: Visit): void {
    v.leaving = true
    const stop = v.errand.stops[0]
    if (v.errand.state !== 'act') stop.visit = undefined
    for (const b of stop.beats) b.dur = Math.min(b.dur, 0.4)
    this.host.say(v.key, null)
  }

  private end(v: Visit): boolean {
    this.visits.delete(v.key)
    this.host.say(v.key, null)
    const sm = this.host.brain(v.key)
    if (!sm || sm.errand !== v.errand) return true
    sm.errand = null
    // Ainda em curso (o encerramento à força, ao fechar): solta e manda de volta ao lugar.
    if (active(v.errand)) {
      v.errand.state = 'aborted'
      sm.prop = null
      if (sm.mode === 'fixed') goStand(sm, sm.home.x, sm.home.z, sm.home.yaw, 'walk')
    }
    return true
  }

  /** Demonstração: um agente da demo na mesa, numa sala com SM; a cada 3ª, um corte. */
  private demoVisit(): void {
    const options: Brain[] = []
    for (const b of this.host.brains()) {
      if (!b.key.startsWith('conv:') || !b.projectId || !this.host.brain(`scrum:${b.projectId}`)) continue
      if (visitSpotOf(b, this.spot) && !this.visits.has(`scrum:${b.projectId}`)) options.push(b)
    }
    if (options.length === 0) return
    const b = options[this.demoTurn % options.length]
    const hold = this.demoTurn % 3 === 2
    this.demoTurn += 1
    const text = hold ? 'Parei o envio: o mesmo teste rodou 9 vezes sem mudar nada.' : 'A etapa passou de 150% do prazo. O que falta para fechar?'
    this.push({ convId: b.key.slice('conv:'.length), text, hold }, true)
  }

  /** As visitas em curso (testes e validação). */
  get visiting(): Array<{ key: string; target: string; hold: boolean; state: Errand['state'] }> {
    return [...this.visits.values()].map((v) => ({ key: v.key, target: v.target, hold: v.req.hold, state: v.errand.state }))
  }

  dispose(): void {
    this.off()
    this.pending = []
    for (const v of [...this.visits.values()]) this.end(v)
  }
}
