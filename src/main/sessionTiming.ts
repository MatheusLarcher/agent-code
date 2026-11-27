// Tempo de cada etapa de uma sessão e de cada turno, para achar onde a resposta
// demora. Uma linha `turn-timing` por turno no sessions.log (só números, nunca
// texto). O primeiro turno leva junto as etapas da subida da sessão.
import { logSession } from './sessionLog'

export class SessionTiming {
  private readonly startedAt: number
  private startPhases: Record<string, number> | null = {}
  private last: number
  private turn: { at: number; marks: Record<string, number> } | null = null

  constructor(private readonly convId: string, private readonly now: () => number = Date.now) {
    this.startedAt = now()
    this.last = this.startedAt
  }

  /** Etapa da subida: ms desde a etapa anterior. Ignorado depois do 1º turno. */
  phase(name: string): void {
    if (!this.startPhases) return
    const t = this.now()
    this.startPhases[name] = t - this.last
    this.last = t
  }

  turnStart(): void {
    this.turn = { at: this.now(), marks: {} }
  }

  /** Marco do turno (ms desde o envio); só o primeiro de cada nome conta. */
  mark(name: string): void {
    if (this.turn && !(name in this.turn.marks)) this.turn.marks[name] = this.now() - this.turn.at
  }

  turnEnd(apiMs?: number): void {
    if (!this.turn) return
    this.mark('result')
    const ms: Record<string, number> = { ...this.turn.marks }
    if (typeof apiMs === 'number') ms.api = apiMs
    if (this.startPhases) {
      for (const [k, v] of Object.entries(this.startPhases)) ms[`start.${k}`] = v
      ms.startToSend = this.turn.at - this.startedAt
      this.startPhases = null
    }
    logSession('turn-timing', { convId: this.convId, ms })
    this.turn = null
  }
}
