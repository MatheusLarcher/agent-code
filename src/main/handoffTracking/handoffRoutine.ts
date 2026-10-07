import { isEnvioRemoved, isEnvioSent, isRoutineEnvio, HANDOFF_ROUTINE_FILE, type HandoffEnvio } from '../../shared/handoffTracking'
import type { PoAuthorization } from '../../shared/poAuthorization'
import type { HandoffRepository } from '../persistence/types'

/**
 * O ITEM DE ROTINA da fila (commit/push autorizado ao PO): um envio especial,
 * sem arquivo em `_handoff/`, que sai NA FRENTE dos prompts assim que a
 * conversa fica livre (handoffQueue.decideQueue). Uma rotina esperando por
 * conversa basta — um commit cobre todas as mudanças. Ao sair, ela já conta
 * como concluída: quem confirma o commit é o fechamento seguinte ou o vigia do
 * git, na pendência do quadro.
 */

export interface RoutineDeps {
  repository(): HandoffRepository | null
  /** Avisa a tela e o despachante (handoff:changed). */
  changed(conversationId: string): void
}

export interface RoutineInput {
  conversationId: string
  conversationTitle: string
  cwd: string
  projectId: string
  /** O texto fixo, montado pelo código (po/poAuthorization.routineText). */
  text: string
}

/** O prompt de implantação conta como fila: o que ainda espera ou não terminou. */
function openPrompts(envios: readonly HandoffEnvio[]): HandoffEnvio[] {
  return envios.filter((e) => !isRoutineEnvio(e) && !isEnvioRemoved(e) && e.status !== 'concluida')
}

/** A conversa tem fila de implantação em andamento? E de qual plano (lote)? */
export function conversationQueue(envios: readonly HandoffEnvio[]): { hasQueue: boolean; loteId: string | null } {
  const open = openPrompts(envios).sort((a, b) => a.ordem - b.ordem)
  return { hasQueue: open.length > 0, loteId: open[0]?.loteId ?? null }
}

/** O alcance "desta fila" acabou: o plano não tem prompt aberto nem rotina esperando. */
export function authorizationExpired(auth: PoAuthorization, envios: readonly HandoffEnvio[]): boolean {
  if (auth.scope !== 'fila') return false
  const routineWaiting = envios.some((e) => isRoutineEnvio(e) && !isEnvioSent(e) && !isEnvioRemoved(e))
  const lote = auth.loteId ? envios.filter((e) => e.loteId === auth.loteId) : envios
  return !routineWaiting && openPrompts(lote).length === 0
}

/** Põe a rotina na frente da fila da conversa. `false` = já havia uma esperando (ou sem banco). */
export async function queueRoutine(deps: RoutineDeps, input: RoutineInput): Promise<boolean> {
  const repo = deps.repository()
  if (!repo) return false
  const envios = await repo.listHandoffEnvios({ conversationId: input.conversationId })
  if (envios.some((e) => isRoutineEnvio(e) && !isEnvioSent(e) && !isEnvioRemoved(e))) return false
  // O plano em curso empresta a identidade (a faixa a mostra no grupo dele);
  // conversa sem plano ganha um lote só das rotinas.
  const base = openPrompts(envios).sort((a, b) => a.ordem - b.ordem)[0] ?? envios[0]
  const queued = envios.filter((e) => !isEnvioSent(e) && !isEnvioRemoved(e)).map((e) => e.ordem)
  await repo.createHandoffEnvios([
    {
      planSlug: base?.planSlug ?? 'rotina',
      planTitulo: base?.planTitulo ?? 'Rotina do PO',
      projectId: base?.projectId ?? input.projectId,
      projectCwd: base?.projectCwd ?? input.cwd,
      conversationId: input.conversationId,
      conversationTitle: base?.conversationTitle ?? input.conversationTitle,
      arquivo: HANDOFF_ROUTINE_FILE,
      // Só para mostrar: a fila põe a rotina na frente pela marca, não pela ordem.
      ordem: queued.length > 0 ? Math.min(...queued) : Math.max(0, ...envios.map((e) => e.ordem)) + 1,
      loteId: base?.loteId ?? `rotina-${input.conversationId}`,
      conteudo: input.text,
      entregas: []
    }
  ])
  deps.changed(input.conversationId)
  return true
}
