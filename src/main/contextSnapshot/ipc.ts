import { Channels } from '../../shared/ipc'
import { CONTEXT_TURNS_ON_SCREEN, type ContextExactCount, type ContextUsageSnapshot } from '../../shared/contextSnapshot'
import type { ContextHistoryRepository } from '../persistence/types'
import { countLiveContext, filterDetail, readLiveContext } from './capture'

interface Dependencies {
  handle(channel: string, handler: (_event: unknown, ...args: unknown[]) => unknown): void
  repository(): ContextHistoryRepository
  reveal(name: string): Promise<string | null>
}
const valid = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096

/** IPC local do Electron. Nunca registrar estes handlers na ponte LAN. */
export function registerContextIpc(deps: Dependencies): void {
  deps.handle(Channels.contextTurnsList, async (_e, convId) => {
    if (!valid(convId)) return []
    try { return await deps.repository().listContextTurns(convId, CONTEXT_TURNS_ON_SCREEN) }
    catch { return [] }
  })
  deps.handle(Channels.contextTurnsRead, async (_e, convId, turnId, parentToolUseId) => {
    if (!valid(convId) || !valid(turnId) || (parentToolUseId !== undefined && !valid(parentToolUseId))) return null
    const current = readLiveContext(convId, turnId, parentToolUseId)
    if (current) return current
    try {
      const detail = await deps.repository().readContextTurn(convId, turnId)
      return detail ? filterDetail(detail, parentToolUseId) : null
    } catch { return null }
  })
  deps.handle(Channels.contextTurnsCountExact, async (_e, convId): Promise<ContextExactCount> => {
    if (!valid(convId)) return { ok: false, usage: null, reason: 'Identificador de conversa inválido.' }
    let summary: ContextUsageSnapshot | null = null
    const current = countLiveContext(convId)
    if (current) {
      const result = await current
      if (result.ok || result.usage) return result
      summary = await lastSummary(deps, convId)
      return { ...result, usage: summary }
    }
    summary = await lastSummary(deps, convId)
    return { ok: false, usage: summary, reason: 'Não há sessão viva nesta conversa. Mostrando o último resumo.' }
  })
  deps.handle(Channels.secretsReveal, async (_e, name) => {
    if (!valid(name)) return null
    try { return await deps.reveal(name) } catch { return null }
  })
}
async function lastSummary(deps: Dependencies, convId: string): Promise<ContextUsageSnapshot | null> {
  try {
    const turns = await deps.repository().listContextTurns(convId, CONTEXT_TURNS_ON_SCREEN)
    for (const turn of turns) {
      const detail = await deps.repository().readContextTurn(convId, turn.turnId)
      if (detail?.usage) return detail.usage
    }
  } catch { /* Histórico offline não rejeita o botão. */ }
  return null
}
