/**
 * "Comentar" um trecho da resposta do agente: o formato da citação.
 *
 * A citação vai no próprio texto da mensagem do usuário — é o que o agente lê
 * e é também de onde o histórico tira os blocos já comentados (`parseQuotes`).
 * Para cada trecho, na ordem em que entrou no campo de mensagem:
 *
 *   > ↳ trecho da mensagem <id>
 *   > <linha 1 do trecho>
 *   > <linha 2 do trecho>
 *
 * Um bloco por trecho, separados por uma linha em branco; depois outra linha em
 * branco e o comentário digitado (se houver). Tudo aqui é função pura.
 */
import type { UIMessage } from '../../types'

/** Teto do trecho citado (em caracteres, já contando o "…" do corte). O destaque
 *  refaz o corte com ele (`quoteMatchesBlock`): mudá-lo apaga o destaque dos
 *  trechos cortados que já estão no histórico. */
export const QUOTE_MAX_CHARS = 600
export const QUOTE_ELLIPSIS = '…'
/** Cabeçalho de cada bloco citado; o id da mensagem de origem vem logo depois. */
export const QUOTE_HEADER = '↳ trecho da mensagem'

const HEADER_RE = /^> ↳ trecho da mensagem (\S+)[ \t]*$/

/** Um trecho citado: de que mensagem do agente e o texto (já cortado no teto). */
export interface Quote {
  messageId: string
  text: string
}

/** Tira a linha em branco das pontas e o espaço sobrando no fim de cada linha;
 *  o recuo do começo fica (código citado mantém a indentação). */
function tidy(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
}

/** O texto do bloco pronto para citar: arrumado e, se passar do teto, cortado
 *  com "…" (o resultado nunca passa de `max` caracteres). */
export function clipQuote(raw: string, max = QUOTE_MAX_CHARS): string {
  const text = tidy(raw)
  if (text.length <= max) return text
  let cut = text.slice(0, Math.max(0, max - QUOTE_ELLIPSIS.length))
  // Não deixa meio emoji (par substituto partido) antes do "…".
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return cut.trimEnd() + QUOTE_ELLIPSIS
}

/** Um bloco `>` com o cabeçalho e as linhas do trecho. */
export function formatQuote(q: Quote): string {
  const lines = q.text.split('\n').map((l) => (l ? `> ${l}` : '>'))
  return [`> ${QUOTE_HEADER} ${q.messageId}`, ...lines].join('\n')
}

/** A mensagem que sai: os blocos citados e, no fim, o comentário. Sem trecho,
 *  o texto sai exatamente como foi digitado. */
export function buildQuotedMessage(quotes: readonly Quote[], comment: string): string {
  if (quotes.length === 0) return comment
  const blocks = quotes.map(formatQuote).join('\n\n')
  return comment.trim() ? `${blocks}\n\n${comment}` : blocks
}

/** O caminho inverso: os trechos citados numa mensagem do usuário. */
export function parseQuotes(text: string): Quote[] {
  const out: Quote[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const head = HEADER_RE.exec(lines[i])
    if (!head) continue
    const body: string[] = []
    while (i + 1 < lines.length && lines[i + 1].startsWith('>') && !HEADER_RE.test(lines[i + 1])) {
      body.push(lines[++i].replace(/^> ?/, ''))
    }
    const quoted = body.join('\n')
    if (quoted.trim()) out.push({ messageId: head[1], text: quoted })
  }
  return out
}

/** Espaços em sequência viram um só: o casamento não depende de quebra de linha. */
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** O trecho citado é deste bloco? Texto igual; ou foi cortado no teto a partir
 *  dele. O "…" no fim sozinho não prova corte ("Aguarde…" é texto): só é corte
 *  se refazer o corte do bloco der o mesmo trecho — o bloco passa do teto e
 *  começa com o que sobrou antes do "…". */
export function quoteMatchesBlock(quoteText: string, blockText: string): boolean {
  const q = norm(quoteText)
  if (!q) return false
  if (norm(blockText) === q) return true
  return q.endsWith(QUOTE_ELLIPSIS) && norm(clipQuote(blockText)) === q
}

/** Os trechos já comentados no histórico, por id da mensagem do agente. A
 *  mensagem cujo envio falhou (`error`) ou foi cancelada não conta: o agente não
 *  leu o comentário (o "Tentar de novo" limpa o `error`, e aí ela volta a contar). */
export function indexCommented(messages: readonly UIMessage[]): Map<string, Quote[]> {
  const byMessage = new Map<string, Quote[]>()
  for (const m of messages) {
    if (m.kind !== 'user' || m.error || m.canceled || !m.text.includes(QUOTE_HEADER)) continue
    for (const q of parseQuotes(m.text)) {
      const list = byMessage.get(q.messageId)
      if (list) list.push(q)
      else byMessage.set(q.messageId, [q])
    }
  }
  return byMessage
}

/** Rótulo curto do chip: a primeira linha do trecho, até `max` caracteres. */
export function chipLabel(text: string, max = 48): string {
  const first = norm(text.split('\n').find((l) => l.trim()) ?? '')
  return first.length > max ? first.slice(0, max - 1).trimEnd() + QUOTE_ELLIPSIS : first
}
