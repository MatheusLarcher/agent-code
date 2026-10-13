/**
 * O histórico de UMA conversa para o celular: em páginas (as últimas N, e "antes
 * de" uma mensagem para as anteriores) e LEVE — o texto do agente vai inteiro,
 * mas a entrada e o resultado de cada ferramenta e o pensamento vão cortados e
 * marcados `light: true`; o celular pede o detalhe inteiro (`detailsByIds`) só
 * quando o usuário expande a resposta. Funções puras: nunca alteram a lista.
 *
 * Página e janela contam só a trilha principal: as ferramentas de subagente
 * (gravadas para o aninhado do chat do PC) ficam de fora, senão um subagente
 * com 40 leituras ocuparia a página inteira do celular.
 */
// Caminho relativo, não o alias `@shared`: o build do main não resolve o alias.
import { mainTrack } from '../../shared/subagentMessages'

/** Tamanho de página padrão e o teto que o celular pode pedir num `limit=`. */
export const HISTORY_PAGE = 50
export const HISTORY_PAGE_MAX = 200
/** Quantos ids o `/api/history-details` aceita de uma vez. */
export const DETAILS_MAX_IDS = 60

/** Cortes da versão leve: o suficiente para a linha-resumo (alvo, "Found N", caminho). */
export const LIGHT_STRING_MAX = 400
export const LIGHT_RESULT_MAX = 600
export const LIGHT_THINKING_MAX = 300
/** A janela em volta de uma pergunta do mapa (antes / depois dela). */
export const WINDOW_BEFORE = 12
export const WINDOW_AFTER = 18

type Loose = { kind?: string; id?: string; text?: string; input?: unknown; result?: { isError?: boolean; text?: string } | null }

const idOf = (m: unknown): string | undefined => {
  const id = (m as Loose | null)?.id
  return typeof id === 'string' ? id : undefined
}

export interface HistoryPage {
  messages: unknown[]
  /** Há mensagens mais antigas que a primeira desta página. */
  hasOlder: boolean
}

/** As `limit` últimas mensagens, ou as `limit` anteriores à mensagem `before` (id). `before` desconhecido: página vazia. */
export function historyPage(conversation: readonly unknown[], opts: { limit?: number | string | null; before?: string | null }): HistoryPage {
  const all = mainTrack(conversation)
  const limit = clampLimit(opts.limit)
  let end = all.length
  if (opts.before) {
    end = all.findIndex((m) => idOf(m) === opts.before)
    if (end < 0) return { messages: [], hasOlder: false }
  }
  const start = Math.max(0, end - limit)
  return { messages: all.slice(start, end), hasOlder: start > 0 }
}

export interface HistoryWindow extends HistoryPage {
  targetId: string
  /** Há mensagens depois da última da janela (o celular não está no fim). */
  hasNewer: boolean
}

/** A janela em volta da mensagem `targetId`; null = ela não está na conversa. */
export function historyWindow(conversation: readonly unknown[], targetId: string): HistoryWindow | null {
  const all = mainTrack(conversation)
  const center = all.findIndex((m) => idOf(m) === targetId)
  if (center < 0) return null
  const start = Math.max(0, center - WINDOW_BEFORE)
  const end = Math.min(all.length, center + WINDOW_AFTER)
  return { messages: all.slice(start, end), targetId, hasOlder: start > 0, hasNewer: end < all.length }
}

/** As mensagens inteiras dos ids pedidos (as que existem), na ordem da conversa. */
export function detailsByIds(all: readonly unknown[], ids: readonly string[]): unknown[] {
  const wanted = new Set(ids.slice(0, DETAILS_MAX_IDS))
  if (!wanted.size) return []
  return all.filter((m) => {
    const id = idOf(m)
    return id !== undefined && wanted.has(id)
  })
}

/** `limit=` do celular: inteiro entre 1 e HISTORY_PAGE_MAX; inválido = a página padrão. */
export function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n < 1) return HISTORY_PAGE
  return Math.min(HISTORY_PAGE_MAX, Math.floor(n))
}

/** A lista leve: só ferramentas e pensamentos mudam (cópias); o resto é a mesma referência. */
export function lightenMessages(list: readonly unknown[]): unknown[] {
  return list.map(lightenMessage)
}

/** A versão leve de uma mensagem, ou ela mesma quando não há o que cortar. */
export function lightenMessage(m: unknown): unknown {
  if (!m || typeof m !== 'object') return m
  const msg = m as Loose
  if (msg.kind === 'tool-use') {
    const input = lightenValue(msg.input)
    const result = msg.result && typeof msg.result.text === 'string' && msg.result.text.length > LIGHT_RESULT_MAX
      ? { ...msg.result, text: cut(msg.result.text, LIGHT_RESULT_MAX) }
      : msg.result
    if (input.cut || result !== msg.result) return { ...msg, input: input.value, result, light: true }
    return m
  }
  if (msg.kind === 'thinking' && typeof msg.text === 'string' && msg.text.length > LIGHT_THINKING_MAX) {
    return { ...msg, text: cut(msg.text, LIGHT_THINKING_MAX), light: true }
  }
  return m
}

const cut = (s: string, max: number): string => s.slice(0, max) + '…'

/** Corta cada string longa dentro da entrada (objetos e listas por dentro); `cut` diz se algo mudou. */
function lightenValue(v: unknown, depth = 0): { value: unknown; cut: boolean } {
  if (typeof v === 'string') return v.length > LIGHT_STRING_MAX ? { value: cut(v, LIGHT_STRING_MAX), cut: true } : { value: v, cut: false }
  if (!v || typeof v !== 'object' || depth > 6) return { value: v, cut: false }
  if (Array.isArray(v)) {
    let changed = false
    const out = v.map((item) => {
      const r = lightenValue(item, depth + 1)
      changed ||= r.cut
      return r.value
    })
    return changed ? { value: out, cut: true } : { value: v, cut: false }
  }
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
    const r = lightenValue(item, depth + 1)
    changed ||= r.cut
    out[k] = r.value
  }
  return changed ? { value: out, cut: true } : { value: v, cut: false }
}
