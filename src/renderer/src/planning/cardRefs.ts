/**
 * Referências a cards no texto: [[Título do card]] — pelo NOME, não pelo id.
 *
 * Lógica pura e genérica (lista de cards + texto), sem React nem editor: o
 * CardEditor usa no corpo do card, o layout usa para desenhar as setas e o
 * chat do Agent Manager usa no Composer e nas mensagens. A busca ignora caixa
 * e acento nos dois sentidos (na query E nos títulos). Id continua valendo por
 * compatibilidade: [[id]].
 */
import type { PlanningCardType } from '@shared/ipc'

/** O mínimo de um card para ser citado. */
export interface RefCard {
  id: string
  titulo: string
  tipo: PlanningCardType
}

/** O '[[' aberto antes do cursor: de `start` ('[[') até `end` (cursor). */
export interface RefTrigger {
  start: number
  end: number
  /** O que já foi digitado depois do '[['. */
  query: string
}

/** Query mais longa que isto não é mais uma referência sendo digitada. */
export const REF_QUERY_MAX = 80
export const REF_LIMIT = 8
/** Prefixo do link que a prévia markdown usa para pintar a referência. */
export const REF_HREF_PREFIX = '#card-ref/'

// Rótulo sem colchete nem quebra de linha: é o que cabe entre [[ e ]].
const REF_RE = /\[\[([^[\]\r\n]{1,1000})\]\]/g
const UNSAFE_LABEL = /[[\]\r\n]/

/** Sem acento, minúsculo, sem espaço sobrando — o mesmo nos dados e na busca. */
export function normalizeRefText(s: string | null | undefined): string {
  return (s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
}

/** Há um '[[' aberto logo antes do cursor? (sem ']', '[' nem quebra de linha no meio) */
export function detectRefTrigger(text: string, cursor: number | null | undefined): RefTrigger | null {
  if (cursor == null || cursor < 2 || cursor > text.length) return null
  const start = text.lastIndexOf('[[', cursor - 2)
  if (start < 0) return null
  const query = text.slice(start + 2, cursor)
  if (query.length > REF_QUERY_MAX || /[[\]\r\n]/.test(query)) return null
  return { start, end: cursor, query }
}

/**
 * Cards cujo título contém a query (caixa e acento ignorados). Primeiro os que
 * começam com ela, depois os que têm uma palavra começando com ela, depois o
 * resto — cada grupo na ordem da lista.
 */
export function filterRefCards<T extends RefCard>(
  cards: readonly T[],
  query: string,
  opts: { excludeId?: string; limit?: number } = {}
): T[] {
  const q = normalizeRefText(query)
  const ranked: { card: T; rank: number; i: number }[] = []
  cards.forEach((card, i) => {
    if (opts.excludeId !== undefined && card.id === opts.excludeId) return
    const title = normalizeRefText(card.titulo)
    const at = q ? title.indexOf(q) : 0
    if (at < 0) return
    const rank = at === 0 ? 0 : /[^\p{L}\p{N}]/u.test(title[at - 1]) ? 1 : 2
    ranked.push({ card, rank, i })
  })
  ranked.sort((a, b) => a.rank - b.rank || a.i - b.i)
  return ranked.slice(0, opts.limit ?? REF_LIMIT).map((r) => r.card)
}

/**
 * O que vai entre [[ e ]]: o título. Cai para o id quando o título quebraria a
 * sintaxe ('[', ']', quebra de linha) ou quando outro card de `all` tem o
 * mesmo título normalizado — senão a referência apontaria para o outro.
 */
export function refLabel(card: RefCard, all: readonly RefCard[] = []): string {
  const title = card.titulo.trim().replace(/\s+/g, ' ')
  if (!title || UNSAFE_LABEL.test(title)) return card.id
  const key = normalizeRefText(title)
  const clash = all.some((c) => c.id !== card.id && normalizeRefText(c.titulo) === key)
  return clash ? card.id : title
}

/**
 * Troca o '[[query' do gatilho por '[[rótulo]]'. Se o cursor estava dentro de
 * uma referência já fechada ('[[Lo|gin]]'), o resto dela até ']]' sai junto.
 */
export function insertRef(text: string, trigger: RefTrigger, label: string): { text: string; cursor: number } {
  const before = text.slice(0, trigger.start)
  let after = text.slice(trigger.end)
  const tail = /^[^[\]\r\n]*\]\]/.exec(after)
  if (tail) after = after.slice(tail[0].length)
  const ref = `[[${label}]]`
  return { text: before + ref + after, cursor: before.length + ref.length }
}

/** Rótulos citados com [[...]] no texto, na ordem, sem repetir (pela forma normalizada). */
export function extractRefs(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of (text || '').matchAll(REF_RE)) {
    const label = m[1].trim()
    const key = normalizeRefText(label)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(label)
  }
  return out
}

/**
 * Resolvedor de rótulo → card: pelo título normalizado (o primeiro da lista
 * ganha, se dois tiverem o mesmo) e, por compatibilidade, pelo id exato.
 */
export function makeRefResolver<T extends RefCard>(cards: readonly T[]): (label: string) => T | null {
  const byTitle = new Map<string, T>()
  const byId = new Map<string, T>()
  for (const card of cards) {
    const key = normalizeRefText(card.titulo)
    if (key && !byTitle.has(key)) byTitle.set(key, card)
    if (!byId.has(card.id)) byId.set(card.id, card)
  }
  return (label) => byTitle.get(normalizeRefText(label)) ?? byId.get(label.trim()) ?? null
}

export function resolveRef<T extends RefCard>(label: string, cards: readonly T[]): T | null {
  return makeRefResolver(cards)(label)
}

function escapeLinkText(text: string): string {
  return text.replace(/[\\`*_[\]<>~|]/g, '\\$&')
}

/** O link da prévia é de referência? (esses não navegam) */
export function isRefHref(href: string | null | undefined): boolean {
  return !!href && href.startsWith(REF_HREF_PREFIX)
}

/** O tipo do card de um link `#card-ref/<tipo>/<id>` ('' se não for um). */
export function refHrefTipo(href: string | null | undefined): string {
  return isRefHref(href) ? href!.slice(REF_HREF_PREFIX.length).split('/')[0] : ''
}

/** Um pedaço de texto puro: texto solto ou uma [[ref]] que resolveu (`label` sem os colchetes). */
export type RefSegment<T extends RefCard> = string | { label: string; card: T }

/**
 * Texto puro (sem markdown — ex.: a mensagem do usuário) cortado nas [[refs]]
 * que resolvem; o que não resolve fica no texto, como está.
 */
export function splitRefs<T extends RefCard>(text: string, resolve: (label: string) => T | null): RefSegment<T>[] {
  const src = text || ''
  const out: RefSegment<T>[] = []
  let last = 0
  for (const m of src.matchAll(REF_RE)) {
    const card = resolve(m[1])
    if (!card) continue
    const at = m.index ?? 0
    if (at > last) out.push(src.slice(last, at))
    out.push({ label: m[1].trim(), card })
    last = at + m[0].length
  }
  if (last < src.length) out.push(src.slice(last))
  return out
}

/**
 * Markdown para a prévia: cada [[ref]] que resolve vira o link
 * `#card-ref/<tipo>/<id>` com o rótulo como texto — o CSS pinta pela cor do
 * tipo; o que não resolve fica como está (sem cor). Código (cerca ``` e
 * `inline`) não é tocado.
 */
export function refsToMarkdownLinks(text: string, resolve: (label: string) => RefCard | null): string {
  return (text || '')
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(REF_RE, (whole, label: string, offset: number, src: string) => {
            if (src[offset - 1] === '!') return whole // '![...](...)' viraria imagem
            const card = resolve(label)
            if (!card) return whole
            return `[${escapeLinkText(label.trim())}](${REF_HREF_PREFIX}${card.tipo}/${encodeURIComponent(card.id)})`
          })
    )
    .join('')
}
