/**
 * Trabalho de agente em segundo plano conta como tarefa em andamento. O `result`
 * do turno principal chega com subagentes ainda rodando (snapshot `background-tasks`
 * do SDK): a fila da conversa, e a troca de sessão pendente, esperam eles acabarem.
 * Shell/servidor em segundo plano (`local_bash`) NÃO segura nada — pode rodar para
 * sempre.
 *
 * Quando o último subagente acaba, a fila retoma em três passos: um intervalo curto
 * (o CLI costuma abrir um turno próprio para as notificações), o fim real do turno
 * no main (`waitTurnEnd`) e uma nova conferência de que a conversa continua livre
 * (`ready`). Só então `run` despacha — uma vez por onda: uma onda nova supera a
 * anterior, e `run` nunca roda duas vezes ao mesmo tempo para a mesma conversa.
 */
import type { BackgroundTask } from '@shared/ipc'
import { waitForTurnEnd, type QueueHandoffDeps } from './central/queueHandoff'

/** Intervalo depois do último subagente: o turno de notificação do CLI abre nele. */
export const BACKGROUND_SETTLE_MS = 1_500

/** Subagente (`local_agent`, `remote_agent`…): o tipo contém "agent". */
export function isAgentTask(task: Pick<BackgroundTask, 'type'>): boolean {
  return /agent/i.test(task.type)
}

export function hasAgentBackground(tasks: readonly Pick<BackgroundTask, 'type'>[] | undefined): boolean {
  return !!tasks?.some(isAgentTask)
}

/** O que decide se a fila de uma conversa pode retomar agora. */
export interface QueueResumeState {
  /** Conversa carregada (e não é a Central). */
  exists: boolean
  busy: boolean
  /** Há turno em voo (o envio dele pode ainda estar esperando). */
  inflight: boolean
  /** Stop do "não era aqui" assentando (central/stopHold.ts). */
  stopping: boolean
  /** Um despacho da fila já espera o fim do turno anterior (central/queueHandoff.ts). */
  handoffPending: boolean
  /** Recuperação na conversa (agendada, em curso ou encerrada): ela vem antes. */
  recovery: boolean
  agentBackground: boolean
  /** Há o que fazer: item na fila ou troca de sessão pendente. */
  work: boolean
}

export function canResumeQueue(s: QueueResumeState): boolean {
  return (
    s.exists &&
    s.work &&
    !s.busy &&
    !s.inflight &&
    !s.stopping &&
    !s.handoffPending &&
    !s.recovery &&
    !s.agentBackground
  )
}

export interface BackgroundHold {
  /** Snapshot novo (substitui o anterior). O fim do último subagente agenda a retomada. */
  update(cid: string, tasks: readonly BackgroundTask[]): void
  /** A sessão morreu (desconectada/descartada): os subagentes dela também. */
  clear(cid: string): void
  /** Há subagente rodando nesta conversa. */
  holds(cid: string): boolean
  /** Agenda a retomada da fila (fim dos subagentes, fila restaurada no boot). */
  schedule(cid: string): void
  /** Retomada agendada, esperando o main ou despachando: mensagem nova entra na fila. */
  pending(cid: string): boolean
  dispose(): void
}

export interface BackgroundHoldDeps extends QueueHandoffDeps {
  settleMs: number
  /** A conversa ainda está livre e tem o que fazer (ver canResumeQueue). */
  ready: (cid: string) => boolean
  /** Retoma: aplica a troca de sessão pendente e despacha a cabeça da fila. */
  run: (cid: string) => void | Promise<void>
}

export function createBackgroundHold(deps: BackgroundHoldDeps): BackgroundHold {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const snapshots = new Map<string, readonly BackgroundTask[]>()
  const timers = new Map<string, unknown>()
  const waiting = new Map<string, number>()
  const running = new Set<string>()
  const waves = new Map<string, number>()

  const holds = (cid: string): boolean => hasAgentBackground(snapshots.get(cid))
  const nextWave = (cid: string): number => {
    const wave = (waves.get(cid) ?? 0) + 1
    waves.set(cid, wave)
    const timer = timers.get(cid)
    if (timer !== undefined) clearTimer(timer)
    timers.delete(cid)
    return wave
  }

  const fire = async (cid: string, wave: number): Promise<void> => {
    timers.delete(cid)
    waiting.set(cid, (waiting.get(cid) ?? 0) + 1)
    try {
      await waitForTurnEnd(deps, cid)
    } finally {
      const left = (waiting.get(cid) ?? 1) - 1
      if (left > 0) waiting.set(cid, left)
      else waiting.delete(cid)
    }
    if (waves.get(cid) !== wave || running.has(cid) || holds(cid) || !deps.ready(cid)) return
    running.add(cid)
    try {
      await deps.run(cid)
    } finally {
      running.delete(cid)
    }
  }

  const schedule = (cid: string): void => {
    const wave = nextWave(cid)
    timers.set(cid, setTimer(() => void fire(cid, wave), deps.settleMs))
  }

  return {
    update(cid, tasks) {
      const had = holds(cid)
      snapshots.set(cid, tasks)
      if (holds(cid)) nextWave(cid) // subagente novo: a retomada agendada não vale mais
      else if (had) schedule(cid)
    },
    clear(cid) {
      const had = holds(cid)
      snapshots.delete(cid)
      if (had) schedule(cid)
    },
    holds,
    schedule,
    pending(cid) {
      return timers.has(cid) || waiting.has(cid) || running.has(cid)
    },
    dispose() {
      // Sem trava permanente (o StrictMode desmonta e remonta no dev): só cancela
      // o que estava agendado — e as ondas esperando o main deixam de valer.
      for (const cid of new Set([...timers.keys(), ...waiting.keys()])) nextWave(cid)
    }
  }
}
