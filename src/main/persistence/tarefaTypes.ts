import type { Tarefa, TarefaEstado, TarefaResultado, TarefaRodada } from '../../shared/tarefas'

/**
 * As tarefas agendadas no banco (`tarefas` + `tarefa_rodadas`), nas duas
 * persistências. A trava entre PCs mora na própria linha (`lease_*`, no molde do
 * `conversation_leases`: 60 s de validade, renovada a cada 20 s): só quem a pega
 * roda a rodada, e quem criou a tarefa tem a prioridade — os outros só pegam
 * depois da cortesia de atraso. Horários em ms (epoch) nas colunas que se comparam.
 */

export interface TarefaRegistro extends Tarefa {
  /** A instalação que segura a trava; `null` = livre. */
  leaseDono: string | null
  leaseToken: string | null
  /** Validade da trava (ms); vencida = livre. */
  leaseAte: number | null
}

export interface TarefaClaim {
  id: string
  dono: string
  token: string
  agora: number
  ttlMs: number
  /** Quem não criou a tarefa só pega depois deste atraso (a criadora tem a prioridade). */
  cortesiaMs: number
}

/** O que a rodada muda na tarefa. `concluir` só vale se ela ainda estiver ativa. */
export interface TarefaCamposRodada {
  proximaEm: string | null
  ultimaEm: string
  ultimoResultado: TarefaResultado
  ultimoValor: string | null
  avisadoValor: string | null
  falhasSeguidas: number
  bateuNaoVistoEm: string | null
  concluir: boolean
  atualizadaEm: string
}

export interface TarefaFimRodada {
  id: string
  token: string
  /** Início da rodada (ms): a gravação atrasada não passa por cima de uma rodada mais nova. */
  inicio: number
  agora: number
  /** A rodada (e, se a seguinte chegou com ela rodando, a "pulada"). */
  rodadas: TarefaRodada[]
  campos: TarefaCamposRodada
  /** Rodadas guardadas por tarefa (as mais velhas saem na mesma escrita). */
  guardar: number
}

export interface TarefaEstadoPatch {
  id: string
  estado: TarefaEstado
  proximaEm: string | null
  atualizadaEm: string
}

export interface TarefaRepository {
  /** As ativas e pausadas (as que o agendador e a bolinha veem). */
  listTarefas(): Promise<TarefaRegistro[]>
  /** As últimas `porTarefa` rodadas de cada tarefa, a mais nova primeiro. */
  listTarefaRodadas(tarefaIds: string[], porTarefa: number): Promise<TarefaRodada[]>
  insertTarefa(tarefa: Tarefa): Promise<void>
  /** Pausar, retomar, cancelar. `false` = a tarefa não existe. */
  updateTarefaEstado(patch: TarefaEstadoPatch): Promise<boolean>
  marcarTarefaVista(id: string, atualizadaEm: string): Promise<void>
  /** Conversa apagada: as tarefas dela (ativas e pausadas) viram canceladas. */
  cancelTarefasDaConversa(convId: string, atualizadaEm: string): Promise<number>
  /** Pega a trava da tarefa vencida. `false` = outra instalação tem, ou não venceu. */
  claimTarefa(claim: TarefaClaim): Promise<boolean>
  /** Renova a trava; `false` = perdeu (outra instalação assumiu). */
  renewTarefaLease(id: string, token: string, ate: number): Promise<boolean>
  releaseTarefaLease(id: string, token: string): Promise<void>
  /**
   * UMA transação: a rodada entra, a tarefa muda e a trava solta. Grava se a
   * trava ainda é desta rodada ou, já vencida, se nenhuma rodada mais nova foi
   * gravada. `false` = não gravou (outra instalação rodou depois).
   */
  finishTarefaRodada(fim: TarefaFimRodada): Promise<boolean>
}
