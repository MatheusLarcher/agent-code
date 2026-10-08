/**
 * Busca do celular nas perguntas do PRÓPRIO usuário, em todas as conversas: sem
 * acento e sem caixa, com um trecho curto em volta do acerto. Roda na tela (que tem
 * as conversas carregadas) quando o celular pede — só os resultados atravessam.
 */

export interface RemoteSearchResult {
  id: string
  title: string
  cwd: string
  snippet: string
  messageId: string | null
  updatedAt: number
}

export interface SearchableConversation {
  id: string
  title: string
  cwd: string
  updatedAt: number
  messages: readonly unknown[]
}

/** Lowercase + strip accents, so "selênio" matches "selenio" (accent-insensitive).
 *  Drops Unicode combining marks (U+0300–U+036F) by code point — no literal regex. */
export function fold(s: string): string {
  const n = s.toLowerCase().normalize('NFD')
  let out = ''
  for (let i = 0; i < n.length; i++) {
    const code = n.charCodeAt(i)
    if (code >= 0x300 && code <= 0x36f) continue
    out += n[i]
  }
  return out
}

/** A short, single-line excerpt of `text` centered on the (case-insensitive) hit. */
export function makeSnippet(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  const at = i >= 0 ? i : 0
  const start = Math.max(0, at - 28)
  let s = text.slice(start, at + q.length + 52).replace(/\s+/g, ' ').trim()
  if (start > 0) s = '… ' + s
  if (at + q.length + 52 < text.length) s = s + ' …'
  return s
}

/** As conversas cuja pergunta do usuário (ou título) contém `q`, da mais nova para a mais antiga. */
export function searchUserPrompts(conversations: Iterable<SearchableConversation>, rawQuery: string): RemoteSearchResult[] {
  const q = rawQuery.trim()
  if (!q) return []
  const fq = fold(q)
  const results: RemoteSearchResult[] = []
  for (const c of conversations) {
    let snippet: string | null = null
    let messageId: string | null = null
    for (const m of c.messages as Array<{ kind?: string; text?: string; id?: string }>) {
      if (m && m.kind === 'user' && typeof m.text === 'string' && fold(m.text).includes(fq)) {
        snippet = makeSnippet(m.text, q)
        messageId = typeof m.id === 'string' ? m.id : null
        break
      }
    }
    if (snippet == null && fold(c.title).includes(fq)) snippet = makeSnippet(c.title, q)
    if (snippet != null) results.push({ id: c.id, title: c.title, cwd: c.cwd, snippet, messageId, updatedAt: c.updatedAt })
  }
  results.sort((a, b) => b.updatedAt - a.updatedAt)
  return results
}
