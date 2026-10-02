/**
 * A energia que o motor mostra — a leitura de officePower a cada feed/tique
 * (com a histerese e o consumo de uma leitura para a outra) e, só em DEV, o
 * nível forçado pelo atalho Ctrl+Alt+Shift+B (ciclo cheia → economia → alerta
 * → apagão → cheia…). Quando o ciclo chega no nível real, o override sai e a
 * leitura volta a mandar. Devolve o evento de cada mudança (powerEvents) para
 * a cena (transições, festa) e as falas.
 */
import type { OfficeFeed } from '../office/adapter/feed'
import { officePower, POWER_LEVELS, powerEvents, type OfficePower, type PowerEvent, type PowerLevel } from './power'

/** Carga mostrada para cada nível forçado (sem leitura real que caiba nele). */
export const FORCED_PCT: Readonly<Record<PowerLevel, number>> = { cheia: 82, economia: 42, alerta: 12, apagao: 0 }
/** Sem horário real, o reset forçado fica a esta distância. */
const FORCED_RESET_MS = 47 * 60_000

export class PowerTracker {
  private real: OfficePower | null = null
  private forced: PowerLevel | null = null
  private shown: OfficePower | null = null

  /** A energia em vigor (com o override, se houver). */
  get power(): OfficePower | null {
    return this.shown
  }

  get overridden(): boolean {
    return this.forced !== null
  }

  /** Leitura nova do feed (ou só o relógio andando); devolve o evento, se mudou de nível. */
  update(feed: Pick<OfficeFeed, 'usageLimits'> | null, now: number): PowerEvent | null {
    this.real = officePower(feed, now, this.real)
    return this.show(now)
  }

  /** DEV: força o próximo nível do ciclo; chegando no real, volta à leitura. */
  cycle(now: number): PowerEvent | null {
    const cur = this.shown?.level ?? 'cheia'
    const next = POWER_LEVELS[(POWER_LEVELS.indexOf(cur) + 1) % POWER_LEVELS.length]
    this.forced = this.real && next === this.real.level ? null : next
    return this.show(now)
  }

  private show(now: number): PowerEvent | null {
    const f = this.forced
    const base = this.real
    const next: OfficePower | null = f
      ? {
          pct: FORCED_PCT[f],
          level: f,
          resetsAt: base?.resetsAt ?? now + FORCED_RESET_MS,
          drainPerMin: base?.drainPerMin || 1.5,
          rejected: f === 'apagao',
          samples: base?.samples ?? []
        }
      : base
    const event = powerEvents(this.shown, next)
    this.shown = next
    return event
  }
}
