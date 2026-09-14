/**
 * A trava do plano: o agente não escreve no projeto antes de declarar o que vai
 * fazer.
 *
 * Por que é trava e não instrução. Pedir no prompt "declare o plano antes de
 * começar" é instrução, e instrução o modelo esquece — foi exatamente essa a
 * lição que transformou o escopo de escrita no `writeScopeGuard` em vez de uma
 * frase no `TASKS_HINT`. Aqui vale o mesmo: o quadro só é confiável se a
 * declaração for garantida por código.
 *
 * O que ela deliberadamente NÃO faz:
 *
 * - **Não cobre `Bash`.** Rodar teste, build ou `git status` antes de planejar é
 *   trabalho legítimo de investigação; travar isso tornaria a regra um estorvo,
 *   e regra que atrapalha trabalho legítimo é desligada no primeiro dia (a
 *   mesma razão pela qual o `bashWriteScan` não recusa comando desconhecido).
 * - **Não vale para subagente.** Um executor trabalha dentro de uma tarefa que
 *   o supervisor já decompôs; exigir que ele declare um plano próprio duplicaria
 *   o quadro com o mesmo trabalho visto de outro ângulo.
 * - **Não se repete.** Recusa UMA vez por turno. Se o agente insistir na escrita
 *   sem declarar nada, a segunda tentativa passa: o objetivo é lembrar, não
 *   impedir o trabalho de quem decidiu que a tarefa é trivial demais para um
 *   plano.
 */

/** Ferramentas que escrevem no projeto. Mesmo conjunto do escopo de escrita,
 *  menos `Bash` (ver acima). */
const PROJECT_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** As ferramentas com que o agente declara o plano. */
const PLAN_TOOLS = new Set(['TaskCreate', 'TodoWrite'])

export interface PlanGateState {
  /** O agente já declarou o plano nesta sessão. */
  declared: boolean
  /** A trava já recusou uma escrita neste turno (recusa uma vez só). */
  refused: boolean
}

export function newPlanGateState(): PlanGateState {
  return { declared: false, refused: false }
}

export function isPlanTool(toolName: string): boolean {
  return PLAN_TOOLS.has(toolName)
}

export const PLAN_GATE_MESSAGE =
  'Antes de escrever no projeto, declare o plano: chame TaskCreate uma vez por passo que você vai executar ' +
  '(e TaskUpdate conforme concluir cada um). É isso que alimenta o Quadro de tarefas que o usuário acompanha. ' +
  'Se a mudança for pequena demais para um plano, crie uma tarefa única descrevendo-a e siga. ' +
  'Esta recusa acontece uma vez por turno — a próxima escrita passa.'

/**
 * A mensagem de recusa, ou `null` quando a escrita pode seguir.
 *
 * Muta `state` porque a trava é "uma vez por turno": quem pergunta é o gate, e
 * o gate é o único chamador.
 */
export function planGateDenial(
  state: PlanGateState,
  toolName: string,
  options: { enabled: boolean; isSubagent: boolean; inTurn: boolean }
): string | null {
  if (!options.enabled || options.isSubagent) return null
  // Fora de um turno não existe pedido do usuário para planejar — e uma trava
  // que dispara sem turno recusaria escrita de caminhos internos do app que
  // nunca passam por um plano.
  if (!options.inTurn) return null
  if (state.declared || state.refused) return null
  if (!PROJECT_WRITE_TOOLS.has(toolName)) return null
  state.refused = true
  return PLAN_GATE_MESSAGE
}

/** Uma chamada de ferramenta aconteceu: se foi a declaração do plano, a trava
 *  se abre para o resto da sessão. */
export function notePlanTool(state: PlanGateState, toolName: string): void {
  if (isPlanTool(toolName)) state.declared = true
}

/** Um turno novo começou. `declared` NÃO é zerado: o plano da conversa
 *  atravessa turnos (o agente reaproveita e atualiza a mesma lista), e exigir
 *  uma declaração nova a cada mensagem transformaria a trava em ruído. O que
 *  zera é só o direito de recusar de novo. */
export function notePlanTurn(state: PlanGateState): void {
  state.refused = false
}
