/**
 * Recusa do modelo (`system/model_refusal_fallback` do SDK): o modelo principal
 * encerrou com stop_reason "refusal" e o CLI refez a resposta em outro modelo.
 * Daqui saem os eventos do chat — a troca de modelo (`provider-switch`, que o
 * seletor do PC e o do celular já seguem), a linha do subagente e a bolha
 * recusada reescrita no lugar (mesmo id: PC e celular trocam o texto pelo id).
 * Puro: quem chama decide se emite (turno aberto) e guarda o modelo da sessão.
 */
import type { ChatEvent } from '../shared/ipc'
import { modelDisplayName } from '../shared/modelLabel'

/** Quantas respostas do agente guardam o id das bolhas (a recusa chega logo depois da resposta recusada). */
export const REFUSAL_BUBBLE_MEMORY = 50

export interface RefusalFallback {
  /** 'session': a conversa seguiu no outro modelo; 'local': só a resposta de um subagente. */
  scope: 'session' | 'local'
  originalModel: string
  fallbackModel: string
  /** uuids das mensagens recusadas que o CLI retirou. */
  retracted: string[]
}

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** A mensagem do SDK validada; null quando não é uma recusa com troca utilizável. */
export function refusalFallbackFrom(message: unknown): RefusalFallback | null {
  if (!message || typeof message !== 'object') return null
  const m = message as Record<string, unknown>
  if (m.type !== 'system' || m.subtype !== 'model_refusal_fallback') return null
  const originalModel = trimmed(m.original_model)
  const fallbackModel = trimmed(m.fallback_model)
  if (!originalModel || !fallbackModel) return null
  const retracted = Array.isArray(m.retracted_message_uuids)
    ? m.retracted_message_uuids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
  // CLI antigo não manda `scope`: vale como troca da sessão (sdk.d.ts).
  return { scope: m.scope === 'local' ? 'local' : 'session', originalModel, fallbackModel, retracted }
}

/** O nome que a tela mostra; um id fora das listas aparece como veio. */
const nameOf = (id: string): string => modelDisplayName(id) || id

export const refusalSwitchText = (r: RefusalFallback): string =>
  `O ${nameOf(r.originalModel)} recusou; a conversa seguiu no ${nameOf(r.fallbackModel)}.`

export const refusalLocalText = (r: RefusalFallback): string =>
  `Um subagente teve a resposta recusada pelo ${nameOf(r.originalModel)}; refeita no ${nameOf(r.fallbackModel)}.`

export const retractedBubbleText = (r: RefusalFallback): string =>
  `_Resposta recusada pelo ${nameOf(r.originalModel)} e refeita no ${nameOf(r.fallbackModel)}._`

/** O que a sessão sabe na hora da troca. */
export interface RefusalContext {
  /** Os ids das bolhas de texto de uma resposta do agente, pelo uuid dela. */
  bubblesOf: (uuid: string) => readonly string[]
  effort?: string
  fastMode: boolean
  newId: () => string
}

/** Os eventos do chat, na ordem: bolhas recusadas reescritas, depois a troca (ou a linha do subagente). */
export function refusalFallbackEvents(r: RefusalFallback, ctx: RefusalContext): ChatEvent[] {
  const events: ChatEvent[] = []
  const retractedText = retractedBubbleText(r)
  for (const uuid of r.retracted) {
    for (const id of ctx.bubblesOf(uuid)) events.push({ kind: 'assistant-text', id, text: retractedText, final: true })
  }
  if (r.scope === 'local') {
    events.push({ kind: 'status', id: ctx.newId(), text: refusalLocalText(r) })
    return events
  }
  events.push({
    kind: 'provider-switch',
    id: ctx.newId(),
    fromModel: r.originalModel,
    model: r.fallbackModel,
    ...(ctx.effort ? { effort: ctx.effort } : {}),
    fastMode: ctx.fastMode,
    text: refusalSwitchText(r)
  })
  return events
}

/** uuid da resposta do agente → ids das bolhas de texto que ela virou; só as últimas `limit`. */
export class RefusalBubbleIndex {
  private readonly byUuid = new Map<string, string[]>()

  constructor(private readonly limit = REFUSAL_BUBBLE_MEMORY) {}

  remember(uuid: unknown, ids: readonly string[]): void {
    if (typeof uuid !== 'string' || !uuid || ids.length === 0) return
    this.byUuid.delete(uuid)
    this.byUuid.set(uuid, [...ids])
    for (const oldest of this.byUuid.keys()) {
      if (this.byUuid.size <= this.limit) break
      this.byUuid.delete(oldest)
    }
  }

  /** Os ids da resposta, esquecendo-a: a retirada vale uma vez. */
  take(uuid: string): readonly string[] {
    const ids = this.byUuid.get(uuid) ?? []
    this.byUuid.delete(uuid)
    return ids
  }
}
