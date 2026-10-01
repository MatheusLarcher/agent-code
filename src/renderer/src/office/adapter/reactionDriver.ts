/**
 * Ponte entre o diretor e o decisor de reações (behavior/reactions). Guarda,
 * por id do motor, os sinais de importância da tarefa (busySince, passos,
 * edições) e dispara as reações dos 3 momentos-chave no OfficeState:
 *   - chamado(): o principal foi chamado à reunião (meetingHold on);
 *   - finished(): turno terminou bem ('ok') ou trilha de subagente encerrou;
 *   - failed(): turno/trilha com erro, inclusive o ✗ do crítico.
 * O resto (travamento, limite de uso) só passa por mood() e mexe no humor.
 *
 * Só desenha: showReaction não toca no caminho, então nunca atrasa ninguém.
 */
import type { LeisureMode } from '../behavior/leisure'
import { createReactions, type Doing, type MoodSignal, type ReactionMoment, type Reactions } from '../behavior/reactions'
import type { OfficeState } from '../engine/officeState'
import type { Activity } from '../engine/types'

interface TaskStats {
  /** Instante em que ficou ativo; null = parado. */
  busySince: number | null
  steps: number
  edits: number
  /** Retrato da última tarefa, para o 'fim' que chega depois do ocioso. */
  last: { busyMs: number; steps: number; edits: number } | null
}

export interface MomentInfo {
  /** Estava trabalhando (o chamado chega depois do diretor desligar o trabalho). */
  busy?: boolean
  /** Revisor (crítico): trabalhando conta como 'revisao'. */
  reviewer?: boolean
  /** O erro é o ✗ do crítico. */
  critic?: boolean
  /** Delegações abertas do personagem. */
  openTracks?: number
  /** Modo de lazer ANTES de acordar (chamado). */
  leisure?: LeisureMode | null
}

export class ReactionDriver {
  private readonly stats = new Map<number, TaskStats>()

  constructor(
    private readonly state: Pick<OfficeState, 'showReaction' | 'getCharacter'>,
    readonly reactions: Reactions = createReactions(),
    private readonly now: () => number = Date.now
  ) {}

  /** O diretor avisa toda mudança de trabalho aplicada no motor. */
  work(id: number, active: boolean, activity: Activity, prevActivity: Activity): void {
    const s = this.of(id)
    const t = this.now()
    if (active && s.busySince === null) {
      s.busySince = t
      s.steps = 0
      s.edits = 0
    }
    if (activity !== null && activity !== prevActivity) {
      s.steps++
      if (activity === 'type') s.edits++
    }
    if (!active && s.busySince !== null) {
      s.last = { busyMs: t - s.busySince, steps: s.steps, edits: s.edits }
      s.busySince = null
    }
  }

  chamado(id: number, info: MomentInfo = {}): void {
    this.moment(id, 'chamado', info)
  }

  finished(id: number, info: MomentInfo = {}): void {
    this.moment(id, 'fim', info)
  }

  failed(id: number, info: MomentInfo = {}): void {
    this.moment(id, 'erro', info)
  }

  /** Volta da reunião: limpa a cara de chegada que ainda não aconteceu. */
  released(id: number): void {
    const ch = this.state.getCharacter(id)
    if (ch?.reactionOnArrive) this.state.showReaction(id, null, 0, null)
  }

  mood(id: number, signal: MoodSignal): void {
    this.reactions.nudge(id, signal, this.now())
  }

  forget(id: number): void {
    this.stats.delete(id)
    this.reactions.forget(id)
  }

  private moment(id: number, moment: ReactionMoment, info: MomentInfo): void {
    const ch = this.state.getCharacter(id)
    if (!ch) return
    const t = this.now()
    const s = this.of(id)
    const task =
      s.busySince !== null ? { busyMs: t - s.busySince, steps: s.steps, edits: s.edits } : (s.last ?? { busyMs: 0, steps: 0, edits: 0 })
    const choice = this.reactions.decide(id, {
      moment,
      doing: doingOf(info.busy ?? (s.busySince !== null || ch.isActive), info),
      ...task,
      openTracks: info.openTracks ?? 0,
      critic: info.critic,
      blocked: ch.bubble === 'permissao' || ch.bubble === 'pergunta',
      now: t
    })
    // Tarefa contada: o próximo 'fim' não reaproveita o mesmo retrato.
    if (moment !== 'chamado') s.last = null
    if (!choice) return
    this.state.showReaction(id, choice.kind, choice.durationSec, choice.onArrive)
    if (choice.onArrive) this.reactions.noteShown(id, choice.onArrive, t)
  }

  private of(id: number): TaskStats {
    let s = this.stats.get(id)
    if (!s) {
      s = { busySince: null, steps: 0, edits: 0, last: null }
      this.stats.set(id, s)
    }
    return s
  }
}

function doingOf(busy: boolean, info: MomentInfo): Doing {
  if (busy) return info.reviewer ? 'revisao' : 'tarefa'
  if (info.leisure === 'dormir') return 'dormindo'
  if (info.leisure === 'celular') return 'celular'
  return 'parado'
}
