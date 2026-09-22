/**
 * Ponto único para avisar a tela de mudanças feitas PELO AGENTE (ferramentas
 * plan_*) num planejamento.
 *
 * Essas gravações passam pelo planningStore, que as registra como "próprias"
 * (planningWrites) — então o planningWatcher as trata como eco e fica calado.
 * Sem este aviso, a tela aberta não recarregaria quando o Agent Manager cria
 * ou altera um card.
 *
 * O planningIpc registra o sink (o mesmo `send(Channels.planningChanged, ...)`
 * que o vigia usa); as ferramentas só chamam notifyPlanningChanged. Sem sink
 * registrado (testes, app sem janela), o aviso é no-op.
 */

export interface PlanningChangeNotice {
  projectCwd: string
  slug: string
}

export type PlanningChangeSink = (change: PlanningChangeNotice) => void

let sink: PlanningChangeSink | null = null

/**
 * Registra (ou troca) o destino dos avisos. Devolve a função que o desfaz —
 * e que só desfaz se o sink ainda for este, para um registro mais novo não
 * ser apagado pelo encerramento de um antigo.
 */
export function setPlanningChangeSink(fn: PlanningChangeSink | null): () => void {
  sink = fn
  return () => {
    if (sink === fn) sink = null
  }
}

/** Avisa a tela; nunca lança (a gravação já aconteceu e não pode "falhar" por isso). */
export function notifyPlanningChanged(change: PlanningChangeNotice): void {
  const current = sink
  if (!current) return
  try {
    current({ projectCwd: change.projectCwd, slug: change.slug })
  } catch (err) {
    console.warn('[planning] falha ao avisar mudança feita pelo agente:', err)
  }
}
