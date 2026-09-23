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
import type { AgentCodeApi } from '@shared/api'
import {
  clampEffortToModel,
  isAutoModel,
  PLANNING_AUTO_FALLBACK,
  type PlanningConfig,
  PLANNING_MODELS,
  type AutoPrompt,
  type PlanningRef,
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
 *  Modelo e esforço são os do Agent Manager NA HORA do envio (o último que o
 *  usuário escolheu na Tela de Planejamento). Automático segue Automático: a
 *  conversa leva o sentinel e o Automático dela revalida a cada mensagem, como
 *  em qualquer conversa. Loop e econômico ficam os de uma conversa normal. */
export function handoffConversationFields(
  slug: string,
  titulo: string | undefined,
  manager: PlanningConfig
): Pick<Conversation, 'handoffSlug' | 'title' | 'model' | 'effort' | 'fastMode'> {
  return {
    handoffSlug: slug,
    title: `Implementação: ${titulo?.trim() || slug}`,
    model: manager.model,
    effort: isAutoModel(manager.model) ? manager.effort : clampEffortToModel(manager.model, manager.effort),
    fastMode: false
  }
}

/** Título com que nasce um planejamento criado sem pedir nome (roteiro e
 *  conversa). A 1ª mensagem troca pelo nome automático (conversationTitle.ts). */
export const PLANNING_UNTITLED = 'Sem nome'

/**
 * O título do roteiro de um plano que JÁ existe (o que o cabeçalho da tela
 * mostra), para a conversa que o reabre nascer com o mesmo nome. "Sem nome"
 * volta como está: a conversa nasce "Sem nome" e a 1ª mensagem dá o nome
 * (conversationTitle.ts), como num plano recém-criado. Nunca lança: plano
 * ilegível, IPC fora ou título vazio → undefined (fica "Planejamento: <slug>").
 *
 * Não fecha o que abriu: o planningOpen registra a vigia do plano nesta
 * janela e a tela que abre logo em seguida só a reaproveita. Fechar aqui
 * desligaria a vigia de uma tela desse plano que já estivesse aberta.
 */
export async function existingPlanTitle(
  api: Pick<AgentCodeApi, 'planningOpen'>,
  ref: PlanningRef
): Promise<string | undefined> {
  try {
    const res = await api.planningOpen(ref)
    const titulo = res?.ok ? res.plan.roteiro.titulo?.trim() : ''
    return titulo || undefined
  } catch {
    return undefined
  }
}

/** O que uma conversa nova precisa para ser a Tela de Planejamento de `slug`.
 *  Modelo/esforço são só placeholder: o main os troca pelo par do Manager.
 *  Com `titulo` (o plano acabou de nascer, ou o do roteiro ao reabrir — ver
 *  existingPlanTitle) a conversa leva o MESMO nome do roteiro — é o que mantém
 *  a barra lateral e o cabeçalho da tela iguais; sem ele, usa o slug. */
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
    title: titulo?.trim() || `Planejamento: ${slug}`,
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
