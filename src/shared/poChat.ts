/**
 * O "FALA, PO" (o chat com o PO a partir do quadro), como as duas pontas o
 * veem: a conversa guardada por projeto, as fontes de cada resposta (viram
 * chips) e as opções que o PO oferece (viram botões). O texto da resposta é do
 * modelo; as fontes, os horários e as opções são montados pelo código a partir
 * do que existe de verdade — referência inventada pelo modelo cai fora.
 */

/** De onde o PO tirou a informação. */
export type PoChatSource =
  | { kind: 'conversa'; conversationId: string; title: string; at: number | null }
  | { kind: 'card'; cardId: string; conversationId: string; title: string; thumbUrl: string | null }
  | { kind: 'quadro'; at: number | null }
  | { kind: 'fila' }
  | { kind: 'tarefas' }

/** O que o PO oferece na resposta (um botão cada). */
export type PoChatOption =
  | { kind: 'verificar'; minutes: number; question: string }
  | { kind: 'abrir-card'; cardId: string; conversationId: string; title: string }
  /** "Mandar fazer": `text` é o texto EXATO que vai ao agente (montado pelo código); `sent` depois do clique. */
  | {
      kind: 'mandar'
      conversationId: string
      conversationTitle: string
      cardIds: string[]
      titles: string[]
      text: string
      note?: string | null
      sent?: { conversationId: string; conversationTitle: string; at: number }
    }
  | { kind: 'abrir-conversa'; conversationId: string; title: string }
  | { kind: 'ver-fila' }
  /** Correção do quadro achada na verificação: aplicada só no clique (`applied` depois). */
  | { kind: 'corrigir'; action: 'reabrir'; cardId: string; conversationId: string; title: string; reason: string; applied?: boolean }
  | { kind: 'corrigir'; action: 'criar'; conversationId: string; conversationTitle: string; title: string; reason: string; applied?: boolean }

export interface PoChatMessage {
  id: string
  role: 'usuario' | 'po'
  text: string
  at: number
  /** Só do PO: "Com base em …" e os chips. */
  sources?: PoChatSource[]
  /** O que ninguém confirmou ("o agente disse que terminou, mas ninguém viu no código"). */
  unconfirmed?: string | null
  options?: PoChatOption[]
  /** Resposta verificada (etapa 18): a evidência que o PO juntou. */
  verified?: boolean
  /** O que o PO leu, rodou e encontrou na verificação. */
  evidence?: string[]
  /** A diferença em relação à resposta rápida ("o agente disse que terminou, mas o teste X falha"). */
  difference?: string | null
  /** Falhou (sem resposta do modelo, sem banco): a bolha diz o motivo. */
  error?: string | null
}

export interface PoChatThread {
  projectKey: string
  messages: PoChatMessage[]
}

/** As perguntas prontas (chips acima do campo). */
export const PO_CHAT_QUICK = ['O que falta fazer?', 'O que está travado?', 'O que precisa de mim?', 'Resumo de hoje', 'Dá para commitar?'] as const

/** O chip do cartão selecionado no quadro. */
export function quickAboutCard(title: string): string {
  return `Como está '${title}'?`
}

/** Quantas trocas (pergunta + resposta) o PO lê a cada pergunta. */
export const PO_CHAT_HISTORY_EXCHANGES = 10
/** Quantas mensagens ficam guardadas por projeto (a tela rola por todas). */
export const PO_CHAT_KEEP_MESSAGES = 200

function ago(at: number, now: number): string {
  const min = Math.max(0, Math.round((now - at) / 60_000))
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const h = Math.round(min / 60)
  return h < 24 ? `há ${h} h` : `há ${Math.round(h / 24)} d`
}

/**
 * "Com base na última resposta do agente da conversa 'X' (há 12 min) e no
 * quadro (atualizado há 2 min)" — montado das fontes, com os horários reais.
 */
export function sourcesSentence(sources: readonly PoChatSource[], now: number): string {
  const parts: string[] = []
  const convs = sources.filter((s): s is Extract<PoChatSource, { kind: 'conversa' }> => s.kind === 'conversa')
  for (const c of convs) parts.push(`na última resposta do agente da conversa '${c.title}'${c.at ? ` (${ago(c.at, now)})` : ''}`)
  const board = sources.find((s): s is Extract<PoChatSource, { kind: 'quadro' }> => s.kind === 'quadro')
  const cards = sources.filter((s) => s.kind === 'card').length
  if (board || cards > 0) parts.push(`no quadro${board?.at ? ` (atualizado ${ago(board.at, now)})` : ''}`)
  if (sources.some((s) => s.kind === 'fila')) parts.push('nos próximos prompts')
  if (sources.some((s) => s.kind === 'tarefas')) parts.push('nas tarefas do registro')
  if (parts.length === 0) return 'Sem fonte: o PO não achou isso no quadro nem nas conversas.'
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}` : parts[0]
  return `Com base ${list}.`
}
