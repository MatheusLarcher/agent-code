import type { HandoffTracker } from './handoffTracker'

/**
 * Handle único do acompanhamento dos envios no processo, no molde de
 * `taskLedger()` (tasks/taskRuntime.ts): o HandoffTracker se publica aqui ao
 * nascer, e o servidor MCP `entregas` de cada sessão de handoff o lê A CADA
 * chamada — sem o index.ts precisar passar o tracker para a sessão.
 *
 * `null` antes de existir um tracker (ou nos testes que não sobem nenhum): as
 * ferramentas respondem que o acompanhamento está desligado, sem lançar.
 */
let active: HandoffTracker | null = null

export function setActiveHandoffTracker(tracker: HandoffTracker | null): void {
  active = tracker
}

export function activeHandoffTracker(): HandoffTracker | null {
  return active
}
