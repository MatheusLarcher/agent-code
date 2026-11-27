/**
 * O lembrete do plano: o agente que escreve no projeto sem ter declarado o que
 * vai fazer recebe, junto do resultado da escrita (PostToolUse), o pedido de
 * declarar o plano.
 *
 * Por que lembrete e não recusa. A versão anterior recusava a 1ª escrita: o
 * agente gastava Edit recusado → TaskCreate → o mesmo Edit de novo (reenviando
 * todo o conteúdo). Com o lembrete no resultado são 2 chamadas e o Quadro
 * recebe o plano do mesmo jeito, logo depois.
 *
 * Por que é código e não só instrução. Pedir no prompt "declare o plano antes de
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
 * - **Não se repete.** Lembra UMA vez por turno: o objetivo é lembrar, não
 *   atrapalhar quem decidiu que a tarefa é trivial demais para um plano.
 */

/** Ferramentas que escrevem no projeto. Mesmo conjunto do escopo de escrita,
 *  menos `Bash` (ver acima). */
const PROJECT_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** As ferramentas com que o agente declara o plano. */
const PLAN_TOOLS = new Set(['TaskCreate', 'TodoWrite'])

export interface PlanGateState {
  /** O agente já declarou o plano nesta sessão. */
  declared: boolean
  /** O lembrete já saiu neste turno (uma vez só). */
  reminded: boolean
}

export function newPlanGateState(): PlanGateState {
  return { declared: false, reminded: false }
}

export function isPlanTool(toolName: string): boolean {
  return PLAN_TOOLS.has(toolName)
}

export const PLAN_GATE_MESSAGE =
  'A escrita foi feita, mas você ainda não declarou o plano: chame TaskCreate agora, uma vez por passo ' +
  '(incluindo o que acabou de fazer), e TaskUpdate conforme concluir cada um. É isso que alimenta o Quadro ' +
  'de tarefas que o usuário acompanha. Se a mudança for pequena demais para um plano, crie uma tarefa única descrevendo-a.'

/**
 * O lembrete para anexar ao resultado da escrita, ou `null`.
 *
 * Muta `state` porque é "uma vez por turno": o PostToolUse é o único chamador.
 */
export function planGateReminder(
  state: PlanGateState,
  toolName: string,
  options: { enabled: boolean; isSubagent: boolean; inTurn: boolean }
): string | null {
  if (!options.enabled || options.isSubagent) return null
  // Fora de um turno não existe pedido do usuário para planejar — e uma trava
  // que dispara sem turno recusaria escrita de caminhos internos do app que
  // nunca passam por um plano.
  if (!options.inTurn) return null
  if (state.declared || state.reminded) return null
  if (!PROJECT_WRITE_TOOLS.has(toolName)) return null
  state.reminded = true
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
 *  zera é só o direito de lembrar de novo. */
export function notePlanTurn(state: PlanGateState): void {
  state.reminded = false
}
