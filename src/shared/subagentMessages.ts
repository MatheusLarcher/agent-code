/**
 * Mensagens de subagente na conversa — PURO, vale no main, no renderer e no celular.
 *
 * Desde que a linha do tempo do chat mostra o que o subagente fez (aninhado na
 * chamada Task/Agent, chatSteps.ts), as ferramentas dele ficam GRAVADAS em
 * `Conversation.messages` com `parentToolUseId` = id da chamada. Quem lê a
 * conversa como "o que o agente principal fez" (página do celular, mapa do
 * projeto, memórias usadas, monitor de código, downloads) ignora essas
 * mensagens com estes helpers — o mesmo `parentToolUseId == null` de
 * ChatLive.tsx e de chatSteps.ts (isMainTool).
 */

/** Mensagem de subagente: tem `parentToolUseId` (o id da chamada Task/Agent que o criou). */
export function isSubagentMessage(m: unknown): boolean {
  if (!m || typeof m !== 'object') return false
  return (m as { parentToolUseId?: unknown }).parentToolUseId != null
}

/** A lista só com a trilha principal. Sem subagente nenhum, a MESMA lista (sem cópia). */
export function mainTrack<T>(list: readonly T[]): readonly T[] {
  return list.some(isSubagentMessage) ? list.filter((m) => !isSubagentMessage(m)) : list
}
