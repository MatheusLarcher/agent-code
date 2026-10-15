/**
 * Texto de um PDF para o modelo que não lê PDF direto (DeepSeek: a API
 * compatível não aceita bloco `document`). É o que a ferramenta `ler_pdf` do
 * MCP do app devolve. Só a camada de texto: PDF escaneado vem vazio e diz isso.
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { getDocumentProxy } from 'unpdf'

/** O mesmo teto do Read do CLI por chamada; o resto se pede com `pages`. */
export const PDF_MAX_PAGES_PER_CALL = 20
const PDF_MAX_BYTES = 100 * 1024 * 1024

export const PDF_NO_TEXT = 'PDF sem texto extraível (provavelmente escaneado)'

export interface PdfTextReply {
  ok: boolean
  text: string
}

/** "3" → [3, 3]; "1-5" → [1, 5]. `null` se o formato não vale. */
export function parsePageRange(pages: string): [number, number] | null {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(pages)
  if (!m) return null
  const from = Number(m[1])
  const to = m[2] === undefined ? from : Number(m[2])
  if (from < 1 || to < from) return null
  return [from, to]
}

export async function readPdfText(cwd: string, arquivo: string, pages?: string): Promise<PdfTextReply> {
  const path = isAbsolute(arquivo) ? arquivo : join(cwd, arquivo)
  if (!/\.pdf$/i.test(path)) return { ok: false, text: `Não é um .pdf: ${arquivo}` }
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return { ok: false, text: `Arquivo não encontrado: ${path}` }
  if (info.size > PDF_MAX_BYTES) return { ok: false, text: `PDF grande demais (${Math.round(info.size / 1048576)} MB; limite 100 MB).` }

  let range: [number, number] | null = null
  if (pages !== undefined && pages.trim() !== '') {
    range = parsePageRange(pages)
    if (!range) return { ok: false, text: `pages inválido: "${pages}". Use "3" ou "1-5".` }
  }

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    pdf = await getDocumentProxy(new Uint8Array(await readFile(path)))
  } catch (error) {
    return { ok: false, text: `Não consegui abrir o PDF: ${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    const total = pdf.numPages
    const [from, wantedTo] = range ?? [1, total]
    if (from > total) return { ok: false, text: `O PDF tem ${total} página(s); pages="${pages}" está fora.` }
    const to = Math.min(wantedTo, total, from + PDF_MAX_PAGES_PER_CALL - 1)

    const parts: string[] = []
    let anyText = false
    for (let n = from; n <= to; n++) {
      const page = await pdf.getPage(n)
      const content = await page.getTextContent()
      let pageText = ''
      for (const item of content.items) {
        if (!('str' in item)) continue
        pageText += item.str + (item.hasEOL ? '\n' : '')
      }
      pageText = pageText.trim()
      if (pageText) anyText = true
      parts.push(`--- Página ${n} ---\n${pageText}`)
    }
    if (!anyText) return { ok: true, text: PDF_NO_TEXT }
    const head = `PDF ${path}: ${total} página(s); lidas ${from}-${to}.`
    const more = to < Math.min(wantedTo, total) || (!range && to < total)
      ? `\n\n(Faltam páginas: chame de novo com pages="${to + 1}-${Math.min(total, to + PDF_MAX_PAGES_PER_CALL)}".)`
      : ''
    return { ok: true, text: `${head}\n\n${parts.join('\n\n')}${more}` }
  } finally {
    await pdf.cleanup().catch(() => undefined)
  }
}
