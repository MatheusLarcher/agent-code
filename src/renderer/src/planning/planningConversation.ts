/**
 * Regras da conversa de planejamento (Conversation.mode === 'planning'), fora
 * do App.tsx para serem testáveis sem montar a janela inteira.
 *
 * - A sessão dela sobe como o Agent Manager (StartAgentOptions.planning).
 * - O MODELO dela é decidido no main (planningStartOptions), uma vez, na subida:
 *   a primeira mensagem viaja como autoPrompt para o Automático do Manager, e
 *   o Automático da CONVERSA (revalidar a cada mensagem) nunca roda para ela.
 * - Ela nasce com um modelo concreto de placeholder — nunca o sentinel do
 *   Automático — para nenhum caminho `isAutoModel(conv.model)` do App pegá-la.
 */
import {
  isAutoModel,
  PLANNING_AUTO_FALLBACK,
  PLANNING_MODELS,
  type AutoPrompt,
  type StartAgentOptions
} from '@shared/ipc'
import type { Conversation } from '../types'

type PlanningShape = Pick<Conversation, 'mode' | 'planningSlug' | 'handoffSlug'>

/** A conversa é uma Tela de Planejamento (e sabe qual plano abrir)? */
export function isPlanningConversation<T extends Pick<Conversation, 'mode' | 'planningSlug'>>(
  conv: T | null | undefined
): conv is T & { mode: 'planning'; planningSlug: string } {
  return !!conv && conv.mode === 'planning' && typeof conv.planningSlug === 'string' && conv.planningSlug !== ''
}

/** O Automático da conversa revalida o par a cada mensagem? Nunca na de
 *  planejamento: lá quem decide é o main, na subida da sessão do Manager. */
export function revalidatesAuto(conv: PlanningShape & Pick<Conversation, 'model'>): boolean {
  return isAutoModel(conv.model) && !isPlanningConversation(conv)
}

/** Os campos do startAgent que dependem do tipo da conversa: o plano que o
 *  Manager conduz (planejamento), o plano de onde a conversa nasceu (handoff)
 *  e o autoPrompt, quando houver. Conversa normal: só o autoPrompt. */
export function sessionStartFields(
  conv: PlanningShape,
  auto?: AutoPrompt
): Pick<StartAgentOptions, 'planning' | 'handoff' | 'autoPrompt'> {
  const out: Pick<StartAgentOptions, 'planning' | 'handoff' | 'autoPrompt'> = {}
  if (isPlanningConversation(conv)) out.planning = { slug: conv.planningSlug }
  // O main recusa Manager + handoff na mesma sessão: o planejamento prevalece.
  else if (typeof conv.handoffSlug === 'string' && conv.handoffSlug) out.handoff = { slug: conv.handoffSlug }
  if (auto) out.autoPrompt = auto
  return out
}

/** O que uma conversa nova precisa para ser a implementação do handoff de `slug`.
 *  Modelo e modos ficam os de uma conversa normal (quem cria decide). */
export function handoffConversationFields(
  slug: string,
  titulo?: string
): Pick<Conversation, 'handoffSlug' | 'title'> {
  return { handoffSlug: slug, title: `Implementação: ${titulo?.trim() || slug}` }
}

/** O que uma conversa nova precisa para ser a Tela de Planejamento de `slug`.
 *  Modelo/esforço são só placeholder: o main os troca pelo par do Manager. */
export function planningConversationFields(
  slug: string,
  titulo?: string
): Pick<
  Conversation,
  'mode' | 'planningSlug' | 'title' | 'model' | 'effort' | 'economyMode' | 'loopEnabled' | 'fastMode'
> {
  return {
    mode: 'planning',
    planningSlug: slug,
    title: `Planejamento: ${titulo?.trim() || slug}`,
    model: PLANNING_AUTO_FALLBACK.model,
    effort: PLANNING_AUTO_FALLBACK.effort,
    economyMode: false,
    loopEnabled: false,
    fastMode: false
  }
}

/** Rótulo legível de um model id (o próprio id se não estiver na lista). */
export function managerModelLabel(model: string): string {
  return PLANNING_MODELS.find((m) => m.id === model)?.label ?? model
}
