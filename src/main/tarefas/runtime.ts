import type { TarefasServico } from './servico'

/**
 * Handle único das tarefas agendadas no processo (molde do `taskRuntime`): o
 * index.ts publica o serviço no boot e a sessão registra o MCP `avisos` com ele.
 * O serviço segura a falta de banco sozinho (a fila espera), então não depende
 * do backend estar no ar para existir.
 */
let servico: TarefasServico | null = null

export function configureTarefasRuntime(s: TarefasServico | null): void {
  servico = s
}

export function tarefasServico(): TarefasServico | null {
  return servico
}
