/**
 * Modelo e esforço do celular com as MESMAS regras do seletor do PC
 * (`modelControls` no App.tsx): o que o retrato mostra e como a troca pedida
 * pelo celular é aplicada. Fora do App para ser testável.
 *
 * - Retrato: no Agent Manager valem a config dele (o esforço da conversa é só
 *   placeholder — o main troca pela config quando a sessão sobe), com a lista
 *   PLANNING_MODELS; na conversa comum, o dela. Mais o "Auto · X".
 * - Troca: vai pelo `onModelChange`/`onEffortChange` do `modelControls` (Manager →
 *   config dele; conversa ocupada → fica pendente e entra na próxima mensagem da
 *   fila, pelo restartForSessionConfig). Automático sem TypeSafe é recusado, como
 *   no PC — só que avisando, sem abrir as Configurações do PC no meio do uso.
 */
import { DEFAULT_EFFORT, isAutoEffort, isAutoModel, PLANNING_MODELS, type PlanningConfig } from '@shared/ipc'
import { runningEffort, withAutoModelOption } from '../effortOptions'
import { isPlanningConversation } from '../planning/planningConversation'
import type { Conversation } from '../types'

export interface RemoteModelFields {
  model?: string
  effort: string
  runningEffort?: string
  models?: { id: string; label: string }[]
}

type ModelShape = Pick<Conversation, 'model' | 'effort' | 'autoEffort' | 'mode' | 'planningSlug'>

/** O que o celular mostra: o mesmo que o seletor do PC mostra para esta conversa. */
export function remoteModelFields(c: ModelShape, planning: PlanningConfig, typesafeReady: boolean): RemoteModelFields {
  if (isPlanningConversation(c)) {
    const running = runningEffort(planning.effort, c.autoEffort)
    return {
      model: planning.model,
      effort: planning.effort,
      ...(running ? { runningEffort: running } : {}),
      models: withAutoModelOption(PLANNING_MODELS, typesafeReady, planning.model)
    }
  }
  const effort = c.effort ?? DEFAULT_EFFORT
  const running = runningEffort(effort, c.autoEffort)
  return { model: c.model, effort, ...(running ? { runningEffort: running } : {}) }
}

/** A parte do `modelControls` que a troca usa. */
export interface RemoteModelControls {
  model: string
  effort: string
  onModelChange: (id: string) => void
  onEffortChange: (level: string) => void
}

export const REMOTE_AUTO_NEEDS_TYPESAFE =
  'O celular pediu o modo Automático, mas o TypeSafe não está configurado neste PC: nada foi trocado. Ative o TypeSafe nas Configurações.'

/**
 * Aplica a troca pedida pelo celular. `refused`: nada foi trocado (o retrato tem
 * de voltar ao valor real — o main ecoou o pedido no instantâneo dele).
 */
export function applyRemoteModelChange(
  msg: { model?: string; effort?: string },
  controls: RemoteModelControls,
  typesafeReady: boolean
): { changed: boolean; refused?: string } {
  let changed = false
  if (msg.model && msg.model !== controls.model) {
    if (isAutoModel(msg.model) && !typesafeReady) return { changed, refused: REMOTE_AUTO_NEEDS_TYPESAFE }
    controls.onModelChange(msg.model)
    changed = true
  }
  if (msg.effort && msg.effort !== controls.effort) {
    if (isAutoEffort(msg.effort) && !typesafeReady) return { changed, refused: REMOTE_AUTO_NEEDS_TYPESAFE }
    controls.onEffortChange(msg.effort)
    changed = true
  }
  return { changed }
}
