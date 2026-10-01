/**
 * Liga a máquina de reunião (behavior/meeting) ao escritório: lê o feed do App
 * e o sinal do composer, decide por conversa e manda o PRINCIPAL dela, na sala
 * dela, ao destino 'reuniao' (OfficeDirector.meetingHold → walkToDestination).
 *
 * - Sem destino alcançável: não prende ninguém; o principal fica onde está só
 *   com o balão do modelo, e a tentativa não se repete até a decisão mudar.
 * - O relógio de volta (8 s, 1 s) é um único timer no próximo recheckAt.
 * - Fica no adaptador para o App.tsx não ter lógica de reunião: o runtime
 *   chama update() a cada feed e a cada aviso do composerPresence.
 */
import type { ComposerPresence } from '../../composerPresence'
import { isPlanningConversation } from '../../planning/planningConversation'
import { createMeeting, type Meeting, type MeetingVerdict } from '../behavior/meeting'
import type { OfficeDirector, Scheduler } from './director'
import type { OfficeFeed } from './feed'
import { scanTurn } from './turn'

export interface MeetingDriverOptions {
  presence: (convId: string) => ComposerPresence
  scheduler: Scheduler
  now?: () => number
  meeting?: Meeting
}

export class MeetingDriver {
  private readonly meeting: Meeting
  private readonly now: () => number
  /** Conversas cuja ida falhou (sem destino): não tenta de novo até voltar a 'mesa'. */
  private readonly failed = new Set<string>()
  private readonly known = new Set<string>()
  private timer: unknown = null
  private feed: OfficeFeed | null = null
  /** Última decisão por conversa (testes e diagnóstico). */
  readonly verdicts = new Map<string, MeetingVerdict>()

  constructor(
    private readonly director: Pick<OfficeDirector, 'meetingHold'>,
    private readonly opts: MeetingDriverOptions
  ) {
    this.meeting = opts.meeting ?? createMeeting()
    this.now = opts.now ?? Date.now
  }

  /** Reavalia todas as conversas do feed (o último, se nenhum vier). */
  update(feed: OfficeFeed | null = this.feed): void {
    this.feed = feed
    this.clearTimer()
    if (!feed) return
    const now = this.now()
    let next: number | null = null
    const seen = new Set<string>()
    for (const c of feed.conversations) {
      seen.add(c.id)
      const busy = feed.busyIds.has(c.id)
      const v = this.meeting.evaluate(
        c.id,
        {
          presence: this.opts.presence(c.id),
          busy,
          toolInUse: busy && scanTurn(c.messages).tool !== null,
          pending: feed.permissions[c.id] !== undefined || feed.vigiaAlerts[c.id] !== undefined,
          planning: isPlanningConversation(c) && (c.id === feed.activeId || busy)
        },
        now
      )
      this.verdicts.set(c.id, v)
      this.drive(c.id, v)
      if (v.recheckAt !== null && v.recheckAt > now) next = next === null ? v.recheckAt : Math.min(next, v.recheckAt)
    }
    for (const id of this.known) {
      if (seen.has(id)) continue
      this.meeting.forget(id)
      this.failed.delete(id)
      this.verdicts.delete(id)
    }
    this.known.clear()
    for (const id of seen) this.known.add(id)
    if (next !== null) {
      this.timer = this.opts.scheduler.setTimeout(() => {
        this.timer = null
        this.update()
      }, next - now)
    }
  }

  dispose(): void {
    this.clearTimer()
  }

  private drive(convId: string, v: MeetingVerdict): void {
    const key = `conv:${convId}`
    if (v.place === 'mesa') {
      this.failed.delete(convId)
      this.director.meetingHold(key, false)
      return
    }
    if (this.failed.has(convId)) return
    if (!this.director.meetingHold(key, true)) this.failed.add(convId)
  }

  private clearTimer(): void {
    if (this.timer === null) return
    this.opts.scheduler.clearTimeout(this.timer)
    this.timer = null
  }
}
