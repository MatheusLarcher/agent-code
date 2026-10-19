/**
 * A parte da window.api das tarefas agendadas (a AgentCodeApi a estende). O main
 * é a fonte da verdade: a tela lê a lista, ouve as mudanças e pede as ações.
 */
import type { TarefaAcaoPedido, TarefaVista, Validado } from './tarefas'

export interface TarefasApi {
  tarefasList(): Promise<TarefaVista[]>
  onTarefasChanged(cb: (tarefas: TarefaVista[]) => void): () => void
  tarefasAcao(pedido: TarefaAcaoPedido): Promise<Validado<TarefaVista | null>>
  /** Clique no aviso do Windows: abrir a conversa de origem. */
  onTarefaAbrirConversa(cb: (e: { convId: string }) => void): () => void
}
