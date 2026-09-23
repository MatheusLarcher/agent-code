/**
 * Título automático das conversas (normais e de planejamento), fora do App.tsx
 * para ser testável sem montar a janela.
 *
 * O fluxo, na 1ª mensagem com texto de uma conversa ainda sem nome:
 * 1. na hora, o recuo — o começo do que o usuário digitou (titleSource 'auto');
 * 2. se nenhuma janela de uso do Claude passou de 90%, pede ao main um nome
 *    curto (claude-haiku-4-5, conversation:suggestTitle); na volta, ele só
 *    entra por cima do recuo ('auto' → 'llm'), nunca por cima de um nome do
 *    usuário;
 * 3. renomear pelo usuário grava 'user' e trava: nada automático mexe mais.
 *
 * Conversa de planejamento: o nome final também vai para o título do roteiro
 * (_roteiro.md), para o cabeçalho da tela mostrar o mesmo nome. A pasta (slug)
 * não muda.
 */
import { usageProviderOf, type PlanningRef, type PlanningRoteiroDto, type RateLimitStatus } from '@shared/ipc'
import type { AgentCodeApi } from '@shared/api'
import { PLANNING_UNTITLED } from './planning/planningConversation'
import { DEFAULT_TITLE, type Conversation } from './types'

/** Acima disto em QUALQUER janela do Claude, o nome fica com o recuo. */
export const LLM_TITLE_MAX_UTILIZATION = 0.9

type TitleShape = Pick<Conversation, 'title' | 'titleSource'>

/** O recuo: primeira linha do que o usuário digitou, até 48 caracteres. */
export function deriveTitle(text: string): string {
  const first = text.trim().split('\n')[0].trim()
  if (!first) return DEFAULT_TITLE
  return first.length > 48 ? first.slice(0, 48) + '…' : first
}

/** Um dos títulos de nascimento (conversa nova ou planejamento sem nome). */
export function isDefaultTitle(title: string): boolean {
  return title === DEFAULT_TITLE || title === PLANNING_UNTITLED
}

/** Esta mensagem dá nome à conversa? Só a 1ª com texto, e nunca se o usuário já
 *  escolheu um nome. */
export function wantsAutoTitle(c: TitleShape, text: string): boolean {
  return c.titleSource !== 'user' && isDefaultTitle(c.title) && text.trim() !== ''
}

/** Aplica o recuo, na hora (titleSource 'auto'). Não é a vez → a mesma conversa. */
export function withFallbackTitle<C extends TitleShape>(c: C, text: string): C {
  return wantsAutoTitle(c, text) ? { ...c, title: deriveTitle(text), titleSource: 'auto' } : c
}

/** O nome do LLM só substitui o recuo: com qualquer outra origem, nada muda. */
export function withLlmTitle<C extends TitleShape>(c: C, title: string): C {
  const t = title.trim()
  return c.titleSource === 'auto' && t ? { ...c, title: t, titleSource: 'llm' } : c
}

/** Renomear pelo usuário trava o título. Nome vazio não muda nada. */
export function withUserTitle<C extends TitleShape>(c: C, title: string): C {
  const t = title.trim()
  return t ? { ...c, title: t, titleSource: 'user' } : c
}

/** O nome por LLM só roda com folga no plano: toda janela do Claude (as da
 *  Anthropic; as do GPT não contam) em até 90%. Janela já virada não conta. */
export function claudeUsageAllowsLlmTitle(limits: Record<string, RateLimitStatus>, now = Date.now()): boolean {
  for (const limit of Object.values(limits)) {
    if (usageProviderOf(limit.rateLimitType) !== 'claude') continue
    if (typeof limit.resetsAt === 'number' && limit.resetsAt <= now) continue
    if ((limit.utilization ?? 0) > LLM_TITLE_MAX_UTILIZATION) return false
  }
  return true
}

/** Pede o nome ao main. Qualquer falha (canal ausente, erro, `ok: false`) → null. */
export async function requestLlmTitle(
  api: Pick<AgentCodeApi, 'suggestConversationTitle'>,
  text: string
): Promise<string | null> {
  try {
    const res = await api.suggestConversationTitle({ text })
    return res && res.ok && typeof res.title === 'string' && res.title.trim() ? res.title.trim() : null
  } catch {
    return null
  }
}

export interface RoteiroTitleSyncDeps {
  api: Pick<AgentCodeApi, 'planningOpen' | 'planningClose' | 'planningSaveRoteiro'>
  /** A tela deste plano está aberta nesta janela? Então a vigia da pasta é
   *  dela e o planningOpen daqui só a reaproveitou — não pode ser fechada. */
  isOnScreen: () => boolean
}

/** Gravações de título por plano, em fila: a última pedida é a que fica. */
const roteiroQueues = new Map<string, Promise<unknown>>()

function cleanEtapas(r: PlanningRoteiroDto): PlanningRoteiroDto['etapas'] {
  return r.etapas.map(({ id, titulo, status }) => ({ id, titulo, status }))
}

async function writeRoteiroTitle(ref: PlanningRef, titulo: string, deps: RoteiroTitleSyncDeps): Promise<boolean> {
  try {
    const opened = await deps.api.planningOpen(ref)
    if (!opened?.ok) return false
    let roteiro = opened.plan.roteiro
    // Uma gravação + UMA retentativa: em 'roteiro_conflict' (o Manager mexeu
    // no roteiro no meio), reaplica sobre o atual que veio junto.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (roteiro.titulo === titulo) return true
      const res = await deps.api.planningSaveRoteiro({
        ...ref,
        roteiro: { titulo, etapas: cleanEtapas(roteiro) },
        expectedRev: roteiro.rev ?? 0
      })
      if (res?.ok) return true
      if (res?.code !== 'roteiro_conflict') return false
      roteiro = res.current
    }
    return false
  } catch {
    return false
  } finally {
    if (!deps.isOnScreen()) void Promise.resolve().then(() => deps.api.planningClose(ref)).catch(() => undefined)
  }
}

/**
 * Leva o título da conversa de planejamento para o título do roteiro. Nunca
 * lança; `false` quando não gravou (plano sumiu, conflito repetido, IPC fora).
 */
export function syncRoteiroTitle(ref: PlanningRef, titulo: string, deps: RoteiroTitleSyncDeps): Promise<boolean> {
  const t = titulo.trim()
  if (!t) return Promise.resolve(false)
  const key = `${ref.projectCwd}\u0000${ref.slug}`
  const run = (roteiroQueues.get(key) ?? Promise.resolve()).then(() => writeRoteiroTitle(ref, t, deps))
  const tail = run.catch(() => undefined)
  roteiroQueues.set(key, tail)
  void tail.then(() => {
    if (roteiroQueues.get(key) === tail) roteiroQueues.delete(key)
  })
  return run
}
