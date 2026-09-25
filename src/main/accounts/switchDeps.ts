import type { SwitchTarget } from './switchPolicy'

/**
 * O que a sessão de uma conversa precisa saber das contas Claude para trocar
 * de conta sozinha. Injetado no `ProviderFailoverSession` pelo index.ts; nos
 * testes, um falso com consumo simulado.
 */
export interface AccountSwitchDeps {
  /** Há mais de uma conta Claude? Sem isso, a troca de conta não existe. */
  multiple(): boolean
  /** Interruptor "Troca automática de conta" (padrão: ligado). */
  autoEnabled(): boolean
  /** Fim de turno: consulta a conta atual e, se ela passou de 95%, as outras. */
  turnEndTarget(current: string, model: string | undefined): Promise<SwitchTarget | null>
  /** Estouro: consulta as outras contas e escolhe a de menor consumo não estourada. */
  exhaustedTarget(current: string, model: string | undefined, tried: ReadonlySet<string>): Promise<SwitchTarget | null>
  /** Nome para mostrar: apelido, e-mail ou "Conta N". */
  label(id: string): string
  /** A conversa mudou de conta (os observadores seguem junto). */
  changed(id: string): void
  /** Pega o lease da conversa antes de uma troca com o turno fechado. */
  acquire?(): Promise<void>
}
