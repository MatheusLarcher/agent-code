import { clamp, PO_MAX_TITLE_CHARS } from './poPrompt'

/**
 * O RESUMO do cartão: uma frase curta dizendo do que ele se trata, para o
 * usuário entender o cartão sem perguntar à IA. Vai no campo opcional
 * `| RESUMO: <frase>` das linhas NOVA/FEITA/TITULO e é gravado em `po_note`.
 */
export const PO_SUMMARY_MAX_CHARS = 180

/**
 * Tira o campo `| RESUMO: …` da linha, em qualquer posição: o texto vai até o
 * próximo `| VOCÊ:` (que tem a sua própria leitura) ou até o fim. Marcador sem
 * diferenciar caixa e só como campo próprio, depois de um `|`.
 */
export function splitSummary(text: string): { body: string; summary?: string } {
  const marker = /\|\s*RESUMO\s*:/i.exec(text)
  if (!marker) return { body: text }
  const after = text.slice(marker.index + marker[0].length)
  const next = /\|\s*VOC[EÊ]\s*:/i.exec(after)
  const raw = next ? after.slice(0, next.index) : after
  const rest = next ? after.slice(next.index) : ''
  const summary = clamp(raw, PO_SUMMARY_MAX_CHARS)
  const body = `${text.slice(0, marker.index).trimEnd()} ${rest}`.trim()
  return summary ? { body, summary } : { body }
}

/**
 * O título que cabe no quadro, cortado em palavra inteira. Quando o título vem
 * longo demais e o PO não escreveu resumo, o texto inteiro vira o resumo: o que
 * não coube no título continua legível no cartão em vez de sumir no "…".
 */
export function fitTitle(rawTitle: string, summary?: string): { title: string; summary?: string } {
  const clean = rawTitle.replace(/\s+/g, ' ').trim()
  if (clean.length <= PO_MAX_TITLE_CHARS) return summary ? { title: clean, summary } : { title: clean }
  const cut = clean.slice(0, PO_MAX_TITLE_CHARS - 1)
  const space = cut.lastIndexOf(' ')
  const title = `${(space > PO_MAX_TITLE_CHARS * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.—-]+$/, '')}…`
  return { title, summary: summary ?? clamp(clean, PO_SUMMARY_MAX_CHARS) }
}
