/**
 * window.api.previewReadFile(path): o main lê/converte o arquivo local para a
 * aba Preview. Sem Electron (testável direto):
 *
 *   markdown/json/code/text  texto utf8 até PREVIEW_LIMITS.textBytes (truncated acima)
 *   table                    SheetJS → abas visíveis em string[][] (limite de linhas/colunas);
 *                            csv/tsv: utf8, e windows-1252 se o utf8 sair com "�"
 *   html/media               só a URL do protocolo agent-preview:// (o <webview> carrega)
 *   slides                   pptx → caixas/imagens/tabelas em posição relativa (readPptx)
 *
 * A barreira (absoluto, existe, é arquivo, não sensível) é a mesma do protocolo.
 */
import { promises as fs } from 'node:fs'
import * as XLSX from 'xlsx'
import {
  PREVIEW_LIMITS,
  codeLangFor,
  extOf,
  previewKindFor,
  type PreviewFileResult,
  type PreviewSheet
} from '../../shared/preview'
import { checkPreviewPath } from './previewGuard'
import { readPptx } from './readPptx'
import { previewHtmlUrl, previewMediaUrl } from './previewUrls'

type Fail = Extract<PreviewFileResult, { ok: false }>

const fail = (path: string, reason: Fail['reason'], message: string): Fail => ({ ok: false, path, reason, message })

const MB = 1024 * 1024

/** Lê os primeiros `max` bytes; truncated se o arquivo for maior. */
async function readHead(path: string, size: number, max: number): Promise<{ buf: Buffer; truncated: boolean }> {
  if (size <= max) return { buf: await fs.readFile(path), truncated: false }
  const fh = await fs.open(path, 'r')
  try {
    const buf = Buffer.alloc(max)
    const { bytesRead } = await fh.read(buf, 0, max, 0)
    return { buf: buf.subarray(0, bytesRead), truncated: true }
  } finally {
    await fh.close()
  }
}

/** utf8 sem o BOM e sem o caractere cortado no fim (quando truncado no meio de um multibyte). */
function decodeUtf8(buf: Buffer, truncated: boolean): string {
  let text = new TextDecoder('utf-8').decode(buf)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (truncated) text = text.replace(/�+$/, '')
  return text
}

/** Texto do csv/tsv: utf8; se aparecer "�" (não era utf8), relê como windows-1252 (Excel no Brasil). */
export function decodeDelimited(buf: Buffer): string {
  const utf8 = decodeUtf8(buf, false)
  if (!utf8.includes('�')) return utf8
  return new TextDecoder('windows-1252').decode(buf)
}

/** Aba oculta no arquivo (Hidden 1 = oculta, 2 = "muito oculta"). */
function hiddenSheet(wb: XLSX.WorkBook, i: number): boolean {
  return !!wb.Workbook?.Sheets?.[i]?.Hidden
}

/**
 * Datas no padrão brasileiro: célula de data sem formato ou com o padrão
 * americano do Excel (m/d/aa) vira dd/mm/aaaa (com hh:mm se tiver hora).
 * Formato próprio do arquivo (ex.: "mmm/aa", "dd/mm") fica como está.
 */
function brDates(ws: XLSX.WorkSheet): void {
  for (const key of Object.keys(ws)) {
    if (key[0] === '!') continue
    const c = ws[key] as XLSX.CellObject
    if (c?.t !== 'd' || !(c.v instanceof Date)) continue
    const fmt = typeof c.z === 'string' ? c.z : ''
    if (fmt && !/^m{1,2}[/-]d{1,2}[/-]y/i.test(fmt)) continue
    const time = /h/i.test(fmt) || c.v.getUTCHours() !== 0 || c.v.getUTCMinutes() !== 0
    c.w = XLSX.SSF.format(time ? 'dd/mm/yyyy hh:mm' : 'dd/mm/yyyy', c.v)
  }
}

/**
 * Faixa lida da aba: o !ref preso a tableRows+1 linhas e tableCols colunas. O
 * !ref vem do arquivo (um xlsx de poucos KB pode declarar A1:XFD300000) e o
 * sheet_to_json com defval/blankrows materializa a faixa INTEIRA.
 */
function clampedRange(ws: XLSX.WorkSheet): XLSX.Range | undefined {
  const ref = ws['!ref']
  if (!ref) return undefined
  const r = XLSX.utils.decode_range(ref)
  r.e.r = Math.min(r.e.r, r.s.r + PREVIEW_LIMITS.tableRows)
  r.e.c = Math.min(r.e.c, r.s.c + PREVIEW_LIMITS.tableCols - 1)
  return r
}

const emptyCell = (c: XLSX.CellObject | undefined): boolean => !c || c.v == null || c.v === ''

/** Há dado à direita da última coluna mostrada (dentro das linhas lidas)? Varre só as células que existem. */
function hasCellsBeyond(ws: XLSX.WorkSheet, range: XLSX.Range): boolean {
  for (const key of Object.keys(ws)) {
    if (key[0] === '!') continue
    const at = XLSX.utils.decode_cell(key)
    if (at.c > range.e.c && at.r >= range.s.r && at.r <= range.e.r && !emptyCell(ws[key] as XLSX.CellObject)) return true
  }
  return false
}

/** Converte o workbook em abas de texto, respeitando os limites. */
export function workbookToSheets(wb: XLSX.WorkBook): PreviewSheet[] {
  const out: PreviewSheet[] = []
  wb.SheetNames.forEach((name, i) => {
    if (hiddenSheet(wb, i)) return
    const ws = wb.Sheets[name]
    if (!ws) return
    brDates(ws)
    const range = clampedRange(ws)
    const all = range
      ? XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '', blankrows: true, range })
      : []
    // Linhas vazias no fim (formatação sem dado) não interessam.
    while (all.length && all[all.length - 1].every((c) => c === '' || c == null)) all.pop()
    // A faixa tem uma linha a mais que o limite: se ela sobrou com dado, cortou.
    const truncated = all.length > PREVIEW_LIMITS.tableRows || (!!range && hasCellsBeyond(ws, range))
    const cells = all
      .slice(0, PREVIEW_LIMITS.tableRows)
      .map((r) => r.slice(0, PREVIEW_LIMITS.tableCols).map((c) => (c == null ? '' : String(c))))
    // Colunas vazias à direita (formatação até XFD, sem dado) também saem; as linhas ficam da mesma largura.
    const width = cells.reduce((w, r) => {
      let end = r.length
      while (end > w && r[end - 1] === '') end--
      return Math.max(w, end)
    }, 0)
    const rows = cells.map((r) => r.slice(0, width))
    out.push({ name, rows, truncated })
  })
  return out
}

/** `path` é o pedido (volta na resposta, como nos outros tipos); `real` é o que se lê. */
async function readTable(path: string, real: string, size: number): Promise<PreviewFileResult> {
  if (size > PREVIEW_LIMITS.tableFileBytes) {
    const limit = Math.round(PREVIEW_LIMITS.tableFileBytes / MB)
    return fail(path, 'too-big', `Planilha grande demais para o preview (${Math.round(size / MB)} MB; o limite é ${limit} MB).`)
  }
  const buf = await fs.readFile(real)
  const ext = extOf(path)
  // sheetRows: o SheetJS para de ler na linha tableRows+1 (a sobra marca o corte).
  const opts: XLSX.ParsingOptions = { cellDates: true, cellNF: true, dense: false, sheetRows: PREVIEW_LIMITS.tableRows + 1 }
  const wb =
    ext === 'csv' || ext === 'tsv'
      ? XLSX.read(decodeDelimited(buf), { ...opts, type: 'string', ...(ext === 'tsv' ? { FS: '\t' } : {}) })
      : XLSX.read(buf, { ...opts, type: 'buffer' })
  const sheets = workbookToSheets(wb)
  if (!sheets.length) return fail(path, 'unsupported', 'A planilha não tem nenhuma aba visível.')
  return { ok: true, kind: 'table', path, sheets }
}

/** Lê e converte o arquivo para a aba Preview. Nunca lança: erro vira { ok:false }. */
export async function readPreviewFile(path: string): Promise<PreviewFileResult> {
  const g = await checkPreviewPath(path)
  if (!g.ok) return fail(typeof path === 'string' ? path : '', g.reason, g.message)
  const kind = previewKindFor(path)
  try {
    switch (kind) {
      case 'markdown':
      case 'json':
      case 'code':
      case 'text': {
        const { buf, truncated } = await readHead(g.real, g.size, PREVIEW_LIMITS.textBytes)
        // Nome do highlight.js pela extensão (md, json, typescript…); o renderer decide se usa.
        const lang = codeLangFor(path)
        return { ok: true, kind, path, text: decodeUtf8(buf, truncated), truncated, ...(lang ? { lang } : {}) }
      }
      case 'table':
        return await readTable(path, g.real, g.size)
      case 'slides':
        return await readPptx(path, g.real, g.size)
      case 'html':
        // Pelo caminho REAL: o protocolo confere o arquivo real contra a pasta
        // registrada, e um .html que é link simbólico apontaria para fora dela.
        return { ok: true, kind, path, url: previewHtmlUrl(g.real) }
      case 'media':
        // Registra o caminho: o host `file` só serve o que o app abriu.
        return { ok: true, kind, path, url: previewMediaUrl(path) }
      default:
        return fail(path, 'unsupported', `O preview não abre arquivos .${extOf(path) || '(sem extensão)'}.`)
    }
  } catch (err) {
    console.error('[preview] falha ao ler', path, err)
    return fail(path, 'error', 'Não foi possível ler o arquivo. Ele pode estar corrompido ou aberto em outro programa.')
  }
}
