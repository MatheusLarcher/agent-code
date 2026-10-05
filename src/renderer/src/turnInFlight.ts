/**
 * O turno em voo gravado na conversa (`Conversation.turnInFlight`). Nasce quando o
 * App cria o turno (bolha + `inflightRef`), ganha `sent` quando o envio sai para o
 * main e some no terminal do turno, no Stop e na falha de envio.
 *
 * O app que fecha (ou cai) no meio do turno deixa a marca no banco. No boot,
 * `resumeAfterRestart` decide o que fazer com ela:
 * - turno enviado, com sessão para retomar → recuperação `transient` em poucos
 *   segundos: o fluxo de sempre manda "continue de onde parou" com o `resume`;
 * - tarefa MCP → só limpa e avisa (regra 2: o app não a reenvia sozinho);
 * - nunca saiu (ou sem sessão para retomar) → a bolha vira erro com "Tentar de novo";
 * - recuperação que estava em curso (`scheduledAt` -1) → reagendada.
 * Marca de outro PC (o banco é dividido) fica como está: quem a retoma é o dono.
 */
import type { Conversation, TurnInFlight, TurnRecovery } from './types'

/** Espera da retomada no boot: o app termina de subir (sessões, MCP) antes. */
export const BOOT_RESUME_DELAY_MS = 2_000

export const RESTART_ERROR_TEXT = 'O app foi fechado no meio do turno.'
export const UNSENT_AFTER_RESTART = 'O app foi fechado antes de o agente começar esta mensagem. Tente de novo.'

/** Valida a marca vinda do banco (payload de outra versão, registro torto). */
export function normalizeTurnInFlight(value: unknown): TurnInFlight | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (typeof v.msgId !== 'string' || !v.msgId) return undefined
  return {
    msgId: v.msgId,
    at: typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : 0,
    ...(typeof v.mcpTaskId === 'string' && v.mcpTaskId ? { mcpTaskId: v.mcpTaskId } : {}),
    ...(v.sent === true ? { sent: true as const } : {}),
    ...(typeof v.device === 'string' && v.device ? { device: v.device } : {})
  }
}

export function turnMark(
  msgId: string,
  opts: { mcpTaskId?: string; sent?: boolean; device?: string | null; now?: number } = {}
): TurnInFlight {
  return {
    msgId,
    at: opts.now ?? Date.now(),
    ...(opts.mcpTaskId ? { mcpTaskId: opts.mcpTaskId } : {}),
    ...(opts.sent ? { sent: true as const } : {}),
    ...(opts.device ? { device: opts.device } : {})
  }
}

export function withTurnInFlight(conv: Conversation, mark: TurnInFlight): Conversation {
  return { ...conv, turnInFlight: mark }
}

/** O envio do turno `msgId` saiu. Outra marca (ou nenhuma) fica como está. */
export function withTurnSent(conv: Conversation, msgId: string): Conversation {
  const mark = conv.turnInFlight
  if (!mark || mark.msgId !== msgId || mark.sent) return conv
  return { ...conv, turnInFlight: { ...mark, sent: true } }
}

/** Tira a marca (só a do turno `msgId`, quando informado). Sem marca: o mesmo objeto. */
export function withoutTurnInFlight(conv: Conversation, msgId?: string): Conversation {
  const mark = conv.turnInFlight
  if (!mark || (msgId !== undefined && mark.msgId !== msgId)) return conv
  const { turnInFlight: _gone, ...rest } = conv
  return rest
}

export type RestartNotice = 'resumed' | 'mcp' | 'unsent'

export interface RestartOptions {
  now: number
  /** `installationId` deste PC (`null` = ainda não se sabe: marca com dono não é retomada). */
  self: string | null
  newId: () => string
  maxAttempts: number
  delayMs?: number
}

function withBubbleError(conv: Conversation, msgId: string, text: string): Conversation {
  return {
    ...conv,
    messages: conv.messages.map((m) => (m.kind === 'user' && m.id === msgId ? { ...m, error: text } : m))
  }
}

/** A conversa como ela deve voltar depois de um reinício do app (ver o cabeçalho). */
export function resumeAfterRestart(conv: Conversation, opts: RestartOptions): { conv: Conversation; notice?: RestartNotice } {
  const mark = conv.turnInFlight
  if (mark?.device && mark.device !== opts.self) return { conv }
  const delay = opts.delayMs ?? BOOT_RESUME_DELAY_MS
  const base = mark ? withoutTurnInFlight(conv) : conv
  const recovery = conv.recovery
  if (recovery) {
    // A retomada estava em curso quando o app fechou: sem reagendar, ninguém a
    // dispararia (o timer só pega horário futuro) e a fila ficaria presa atrás dela.
    if (recovery.scheduledAt < 0) {
      return { conv: { ...base, recovery: { ...recovery, scheduledAt: opts.now + delay } }, notice: 'resumed' }
    }
    return { conv: base }
  }
  if (!mark) return { conv }
  if (mark.mcpTaskId) return { conv: base, notice: 'mcp' }
  if (!mark.sent || !conv.sdkSessionId) return { conv: withBubbleError(base, mark.msgId, UNSENT_AFTER_RESTART), notice: 'unsent' }
  const resumed: TurnRecovery = {
    id: opts.newId(),
    reason: 'transient',
    scheduledAt: opts.now + delay,
    attempt: 0,
    maxAttempts: opts.maxAttempts,
    errorText: RESTART_ERROR_TEXT,
    messageId: mark.msgId
  }
  return { conv: { ...base, recovery: resumed }, notice: 'resumed' }
}

/** Os avisos do boot, um por tipo, a partir do que `resumeAfterRestart` disse. */
export function restartNoticeTexts(notices: readonly (RestartNotice | undefined)[]): string[] {
  const count = (kind: RestartNotice): number => notices.filter((n) => n === kind).length
  const texts: string[] = []
  const resumed = count('resumed')
  if (resumed) {
    texts.push(
      resumed === 1
        ? 'Uma conversa foi interrompida pelo fechamento do app — ela continua de onde parou em instantes.'
        : `${resumed} conversas foram interrompidas pelo fechamento do app — elas continuam de onde pararam em instantes.`
    )
  }
  const mcp = count('mcp')
  if (mcp) {
    texts.push(
      `${mcp === 1 ? 'Uma tarefa do Forgia estava' : `${mcp} tarefas do Forgia estavam`} em andamento quando o app fechou e não ` +
        'são reenviadas pelo app (o Forgia pode reenviar).'
    )
  }
  const unsent = count('unsent')
  if (unsent) {
    texts.push(
      `${unsent === 1 ? 'Uma mensagem não chegou' : `${unsent} mensagens não chegaram`} ao agente antes de o app fechar — use "Tentar de novo".`
    )
  }
  return texts
}
