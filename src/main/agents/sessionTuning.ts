import type { StartAgentOptions } from '../../shared/ipc'

/**
 * Afinação da sessão do SDK que depende do TIPO de conversa — pura, testável
 * sem subir o CLI. A sessão só espalha o resultado nas `Options`.
 */

/** Quem é a sessão: comum, Agent Manager (`planning`) ou implementação de handoff (`handoff`). */
export type SessionTuningRole = Pick<StartAgentOptions, 'planning' | 'handoff'>

/**
 * Plugins desligados SÓ nas sessões do app (o terminal do usuário não muda).
 * O superpowers injeta no SessionStart o próprio processo (brainstorming → plano
 * → TDD → review) em todo pedido, por cima do pipeline do app — duas camadas com
 * o mesmo objetivo, e a do app é a verificável (ledger com evidência). Vai em
 * `Options.settings` (camada flag, acima de user/project/local) e na SUBIDA:
 * chave que governa hooks não vale em overlay posterior (sdk.d.ts, `settings`).
 */
export const APP_DISABLED_PLUGINS: Readonly<Record<string, false>> = { 'superpowers@superpowers-marketplace': false }

/** Até quantos subagentes rodam ao mesmo tempo na conversa de handoff (o TASKS_HINT pede até 6). */
export const HANDOFF_MAX_CONCURRENT_SUBAGENTS = 6

/**
 * Janela de compactação da conversa de handoff, em tokens. O contexto médio
 * medido foi de 214k–329k por chamada; compacta em 500k (pedido do usuário) para
 * manter mais contexto antes do resumo. Env (ganha das outras fontes; o limiar
 * efetivo é o menor entre ela e o máximo do modelo) — nunca o percentual
 * `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, que tem relatos de não disparar.
 */
export const HANDOFF_AUTO_COMPACT_WINDOW = 500_000

function isHandoffImplementation(role: SessionTuningRole): boolean {
  return Boolean(role.handoff) && !role.planning
}

/** As variáveis que só a conversa de implementação de handoff recebe. Vazio nas outras. */
export function handoffSessionEnv(role: SessionTuningRole): Record<string, string> {
  if (!isHandoffImplementation(role)) return {}
  return {
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(HANDOFF_MAX_CONCURRENT_SUBAGENTS),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(HANDOFF_AUTO_COMPACT_WINDOW)
  }
}
