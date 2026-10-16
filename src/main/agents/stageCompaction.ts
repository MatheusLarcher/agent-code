import { contextLimitFor } from '../../shared/ipc'
import { HANDOFF_AUTO_COMPACT_WINDOW } from './sessionTuning'

/**
 * Compactação no fim da etapa (só a conversa de implementação de handoff).
 *
 * Um prompt do roteiro roda num turno longo, e a compactação automática do CLI
 * (janela de 500k, sessionTuning.ts) disparava no meio de uma etapa, antes do
 * resumo dela, e o que o agente tinha levantado nos arquivos se perdia. O hook
 * `PreCompact` do SDK aceita `decision: 'block'`: a automática fica adiada até
 * o agente fechar um item `[etapa]` do plano e dispara na chamada seguinte, no
 * mesmo turno (verificado contra o CLI 0.3.296). Um teto protege o limite do
 * modelo: passou dele, compacta mesmo no meio da etapa.
 */

/** Teto absoluto do adiamento: acima dele a automática passa, etapa fechada ou não. */
export const STAGE_COMPACT_MAX_CEILING = 600_000

/** Fração do limite do modelo usada como teto: o contexto medido é o da última resposta, e as ferramentas seguintes somam a ele. */
const CEILING_FRACTION = 0.6

/**
 * Teto do adiamento para o modelo, ou `null` quando não há folga acima da
 * janela de compactação (modelo menor que ~834k): aí a automática nunca é segurada.
 */
export function stageCompactCeiling(model: string | undefined): number | null {
  const ceiling = Math.min(STAGE_COMPACT_MAX_CEILING, Math.floor(contextLimitFor(model) * CEILING_FRACTION))
  return ceiling > HANDOFF_AUTO_COMPACT_WINDOW ? ceiling : null
}

/** Item do plano que é uma etapa do roteiro: começa com o id entre colchetes. */
const STAGE_PREFIX = /^\s*\[[^\]\s][^\]]*\]/

function isStage(subject: unknown): boolean {
  return typeof subject === 'string' && STAGE_PREFIX.test(subject)
}

export type PreCompactDecision = 'allow' | 'block'

/**
 * Estado de uma sessão de handoff: se uma etapa fechou desde a última
 * compactação. Alimentado pelos `PostToolUse` da thread principal.
 */
export class StageCompaction {
  private stageClosed = false
  private deferredNoticeSent = false
  /** Etapas já vistas como concluídas no TodoWrite (ele reenvia a lista inteira). */
  private readonly completedTodos = new Set<string>()
  /** id → assunto, do retorno do TaskCreate (o TaskUpdate só traz o id). */
  private readonly taskSubjects = new Map<string, string>()

  /** Uma ferramenta da thread principal retornou. */
  observeTool(name: string, input: unknown, response: unknown): void {
    const inp = (input ?? {}) as Record<string, unknown>
    if (name === 'TodoWrite' && Array.isArray(inp['todos'])) {
      for (const todo of inp['todos'] as Array<Record<string, unknown>>) {
        const content = todo?.['content']
        if (todo?.['status'] !== 'completed' || !isStage(content) || this.completedTodos.has(content as string)) continue
        this.completedTodos.add(content as string)
        this.stageClosed = true
      }
    } else if (name === 'TaskCreate') {
      const task = ((response ?? {}) as { task?: { id?: unknown; subject?: unknown } }).task
      const subject = task?.subject ?? inp['subject']
      if (task?.id != null && typeof subject === 'string') this.taskSubjects.set(String(task.id), subject)
    } else if (name === 'TaskUpdate') {
      const id = String(inp['taskId'] ?? '')
      if (typeof inp['subject'] === 'string') this.taskSubjects.set(id, inp['subject'])
      if (inp['status'] !== 'completed') return
      // Tarefa criada antes de a sessão subir (retomada): sem o assunto, conta
      // como etapa — compactar num item fechado ainda é um ponto limpo.
      const subject = this.taskSubjects.get(id)
      if (subject === undefined || isStage(subject)) this.stageClosed = true
    }
  }

  /**
   * O CLI vai compactar. `contextTokens` = contexto medido na última resposta
   * (0 = desconhecido); `ceiling` = stageCompactCeiling do modelo da sessão.
   */
  decide(trigger: 'manual' | 'auto', contextTokens: number, ceiling: number | null): PreCompactDecision {
    if (trigger === 'manual' || this.stageClosed || ceiling === null) return 'allow'
    if (contextTokens <= 0 || contextTokens >= ceiling) return 'allow'
    return 'block'
  }

  /** Avisar na tela o primeiro adiamento de cada etapa (true uma vez até a próxima compactação). */
  takeDeferredNotice(): boolean {
    if (this.deferredNoticeSent) return false
    this.deferredNoticeSent = true
    return true
  }

  /** A compactação aconteceu: a próxima espera outra etapa fechar. */
  compacted(): void {
    this.stageClosed = false
    this.deferredNoticeSent = false
  }
}
