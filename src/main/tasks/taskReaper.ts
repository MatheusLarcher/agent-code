import type { Task } from '../persistence/types'
import { TASK_LEASE_TTL_MS } from './taskModel'
import { taskLedger } from './taskRuntime'
import type { TaskLedger } from './taskLedger'

/**
 * Devolve à fila a tarefa cujo executor morreu.
 *
 * O buraco que isto fecha: só tarefa `pending` é reivindicável. Um executor que
 * some no meio do trabalho — subagente que estourou o turno, app fechado, PC
 * suspenso — deixa a tarefa parada em `running` com um lease vencido, e
 * **ninguém consegue assumi-la**. O orçamento de `attempts` não ajuda, porque
 * ele só é gasto no claim: a tarefa não volta a ser distribuída, então não há
 * segunda tentativa. Sem isto, o TTL do lease é só um número no banco.
 *
 * Esta é a primeira regra do time que roda FORA do modelo. Não é o supervisor
 * que percebe o abandono — ele pode ter sido justamente quem morreu.
 *
 * O caminho é `running → failed → pending`, porque `running → pending` não
 * existe na máquina de estados e a passagem por `failed` é o que registra o
 * motivo no histórico. Quando as tentativas acabam, ela **fica** em `failed`:
 * redistribuir para sempre é o loop que o orçamento existe para impedir.
 */

/**
 * Silêncio extra exigido além do TTL antes de considerar abandono. O lease já é
 * renovado a cada escrita, então vencido significa 15 min sem nenhum trabalho;
 * a folga evita competir com um executor que está voltando de um build longo.
 */
export const REAP_GRACE_MS = 5 * 60_000

/** De quanto em quanto tempo o main procura tarefa abandonada. */
export const REAP_POLL_MS = 60_000

/** Teto por passada — o reaper é faxina de fundo, não uma varredura do acervo. */
const REAP_BATCH = 200

export interface ReapOutcome {
  requeued: string[]
  exhausted: string[]
}

/**
 * Abandonada = `running`, com lease vencido há mais que a folga. Tarefa sem
 * lease nenhum em `running` não existe pelo caminho normal (o claim sempre
 * emite um), mas se aparecer também conta: ninguém a está segurando.
 */
export function isAbandoned(task: Task, now: number, graceMs = REAP_GRACE_MS): boolean {
  if (task.status !== 'running') return false
  if (!task.leaseExpiresAt) return true
  const expires = Date.parse(task.leaseExpiresAt)
  if (!Number.isFinite(expires)) return true
  return now - expires > graceMs
}

/**
 * Marca deixada no `owner_agent` pelo `running → failed` do reaper — é o que
 * permite retomar uma reciclagem que morreu no meio, sem confundir com a tarefa
 * que o CRÍTICO reprovou de propósito (essa é decisão dele, não do app).
 */
export const REAPER_AGENT = 'app:reaper'

async function requeue(ledger: TaskLedger, taskId: string): Promise<void> {
  await ledger.transitionTask(taskId, 'failed', 'pending', undefined, {
    agent: REAPER_AGENT,
    reason: 'Devolvida à fila para outro executor assumir.'
  })
}

export async function reapAbandonedTasks(
  ledger: TaskLedger,
  now = Date.now(),
  graceMs = REAP_GRACE_MS
): Promise<ReapOutcome> {
  const outcome: ReapOutcome = { requeued: [], exhausted: [] }

  // Primeiro, termina o serviço de uma passada anterior que morreu entre as duas
  // transições: a tarefa saiu de `running` (o reaper não a veria mais) e não
  // chegou a `pending` (ninguém pode assumi-la) — encalhada, que é exatamente o
  // que este módulo existe para desfazer. Só as que ELE reprovou.
  const failed = await ledger.listTasks({ status: 'failed', limit: REAP_BATCH })
  for (const task of failed) {
    if (task.ownerAgent !== REAPER_AGENT || task.attempts >= task.maxAttempts) continue
    try {
      await requeue(ledger, task.id)
      outcome.requeued.push(task.id)
    } catch {
      /* outra instância chegou antes; a próxima passada reavalia */
    }
  }

  const running = await ledger.listTasks({ status: 'running', limit: REAP_BATCH })
  for (const task of running) {
    if (!isAbandoned(task, now, graceMs)) continue
    const minutes = Math.round(TASK_LEASE_TTL_MS / 60_000)
    const reason = `Lease vencido: o executor "${task.ownerAgent ?? 'desconhecido'}" ficou mais de ${minutes} min sem nenhuma escrita. Tarefa devolvida pelo app, não por um agente.`
    try {
      // O lease já venceu, então a transição não leva fence — é o mesmo caminho
      // por onde o crítico fecha uma tarefa em review.
      await ledger.transitionTask(task.id, 'running', 'failed', undefined, {
        agent: REAPER_AGENT,
        reason
      })
    } catch {
      // Corrida com um executor que voltou à vida e transicionou primeiro: o
      // repositório recusa, e recusar é a resposta certa. A próxima passada
      // reavalia com o estado novo.
      continue
    }
    if (task.attempts >= task.maxAttempts) {
      // Fica em `failed` de propósito: sem orçamento, redistribuir seria o
      // loop que o `attempts` existe para cortar. O supervisor decide.
      outcome.exhausted.push(task.id)
      continue
    }
    try {
      await requeue(ledger, task.id)
      outcome.requeued.push(task.id)
    } catch {
      // Ficou em `failed` marcada como do reaper: a passada seguinte a retoma
      // pela varredura de cima, em vez de deixá-la encalhada.
    }
  }
  return outcome
}

/**
 * Liga a faxina periódica. Devolve a função que a desliga. Só age quando há
 * registro autoritativo — sem banco não há fila para consertar.
 */
export function startTaskReaper(
  pollMs = REAP_POLL_MS,
  log: (message: string) => void = () => {}
): () => void {
  let running = false
  const tick = async (): Promise<void> => {
    // Uma passada por vez: um banco lento não pode empilhar varreduras.
    if (running) return
    const ledger = taskLedger()
    if (!ledger) return
    running = true
    try {
      const outcome = await reapAbandonedTasks(ledger)
      if (outcome.requeued.length || outcome.exhausted.length) {
        log(
          `[tasks] reaper: ${outcome.requeued.length} devolvida(s) à fila, ` +
            `${outcome.exhausted.length} sem tentativas restantes`
        )
      }
    } catch (err) {
      // Faxina de fundo nunca derruba o app; a próxima passada tenta de novo.
      log(`[tasks] reaper falhou: ${String(err)}`)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), pollMs)
  timer.unref?.()
  void tick()
  return () => clearInterval(timer)
}
