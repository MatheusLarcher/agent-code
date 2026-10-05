/**
 * O arquivo que o Agent só LEU, no editor do monitor — PURO (sem React).
 *
 *   readRange(offset, limit)         o trecho pedido ao Read: da linha `offset`
 *                                    (1ª = 1) por `limit` linhas; sem limit, o
 *                                    teto do próprio Read (2000 linhas)
 *   parseReadResult(text)            as linhas numeradas que o Read devolveu
 *                                    ("    95→texto" ou "95\ttexto"); null se o
 *                                    resultado chegou cortado ao renderer
 *   readFileView(input)              as linhas do editor: realce normal, sem cor
 *                                    de diff, só as linhas lidas com as faixas
 *                                    "linhas 1–94 não lidas" / "o resto do arquivo
 *                                    não foi lido"; o texto vem do disco (dentro do
 *                                    projeto) ou do resultado do Read (fora dele)
 *   readSummary(view)                "leu as linhas 95–174" / "leu o arquivo inteiro
 *                                    (65 linhas)" para a barra de status
 */
import type { DiskState, FileView, Row } from './fileView'

/** O Read lê no máximo isto sem `limit`. */
export const READ_DEFAULT_LIMIT = 2000
/** O main corta o texto do resultado de ferramenta aqui (stringifyToolResult). */
export const RESULT_CAP = 4000

export interface ReadRange {
  from: number
  /** Linhas pedidas (o teto quando não veio `limit`). */
  count: number
  partial: boolean
}

export function readRange(offset: number | null, limit: number | null): ReadRange {
  const from = offset !== null && offset > 1 ? Math.floor(offset) : 1
  const count = limit !== null && limit > 0 ? Math.floor(limit) : READ_DEFAULT_LIMIT
  return { from, count, partial: from > 1 || limit !== null }
}

const NUMBERED = /^\s*(\d+)(?:→|\t)(.*)$/u

/** As linhas que o Read devolveu, com o número de cada uma. null: texto cortado ou sem linhas numeradas. */
export function parseReadResult(text: string): Array<{ num: number; text: string }> | null {
  if (text.length >= RESULT_CAP) return null
  const out: Array<{ num: number; text: string }> = []
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = NUMBERED.exec(raw)
    if (m) out.push({ num: Number(m[1]), text: m[2] })
    else if (out.length > 0 && raw.trim()) break // o que vem depois (lembretes do sistema) não é do arquivo
  }
  return out.length > 0 ? out : null
}

export interface ReadViewInput {
  /** O disco (só dentro do projeto e sem nome sensível). */
  disk: DiskState
  offset: number | null
  limit: number | null
  /** O texto do resultado do Read (para o arquivo fora do projeto). */
  result?: string | null
  /** Nome sensível: nunca abre. */
  sensitive?: boolean
  /** Aberto pelo usuário na árvore (não lido pelo Agent): o arquivo inteiro, sem faixas de "não lidas". */
  whole?: boolean
}

export interface ReadView extends FileView {
  /** As linhas mostradas (1ª e última) e o total do arquivo (null = desconhecido). */
  shown: { from: number; to: number; total: number | null } | null
}

const label = (rows: Row[], text: string): void => {
  rows.push({ kind: 'hunk', num: null, src: 2, line: -1, label: text })
}

function view(rows: Row[], after: string, note: string | null, shown: ReadView['shown']): ReadView {
  return { mode: 'plain', rows, before: '', after, blocks: [], added: 0, removed: 0, first: -1, latest: -1, caret: null, note, shown }
}

const DISK_NOTE: Record<string, string> = {
  loading: 'Lendo o arquivo…',
  error: 'Não deu para ler o arquivo.',
  large: 'Arquivo grande demais para abrir aqui.',
  unavailable: 'O conteúdo deste arquivo não está disponível aqui.',
  relative: 'Caminho sem pasta: o conteúdo não está disponível aqui.',
  outside: 'Fora da pasta do projeto: o texto lido não chegou inteiro à tela.'
}

export function readFileView({ disk, offset, limit, result = null, sensitive = false, whole = false }: ReadViewInput): ReadView {
  if (sensitive || (disk.kind === 'none' && disk.reason === 'sensitive')) {
    return view([], '', 'Arquivo sensível: não é aberto aqui, nem o que o Agent leu dele.', null)
  }
  const range: ReadRange = whole ? { from: 1, count: Infinity, partial: false } : readRange(offset, limit)
  const rows: Row[] = []
  if (disk.kind === 'text') {
    const lines = disk.text === '' ? [] : (disk.text.endsWith('\n') ? disk.text.slice(0, -1) : disk.text).split('\n')
    const total = lines.length
    if (range.from > total) {
      label(rows, `A leitura começou na linha ${range.from}, depois do fim do arquivo (${total} linhas).`)
      return view(rows, disk.text, null, null)
    }
    const to = Math.min(total, range.from + range.count - 1)
    if (range.from > 1) label(rows, `linhas 1–${range.from - 1} não lidas`)
    for (let n = range.from; n <= to; n++) rows.push({ kind: 'ctx', num: n, src: 1, line: n - 1 })
    if (to < total) label(rows, `linhas ${to + 1}–${total} não lidas`)
    return view(rows, lines.join('\n'), null, { from: range.from, to, total })
  }
  if (disk.kind === 'missing') return view([], '', 'O arquivo não está mais no disco.', null)
  // Fora do projeto (ou sem disco): o que o próprio Read devolveu, se veio inteiro.
  const parsed = result ? parseReadResult(result) : null
  if (!parsed) return view([], '', DISK_NOTE[disk.reason] ?? DISK_NOTE.unavailable, null)
  const from = parsed[0].num
  const to = parsed[parsed.length - 1].num
  if (from > 1) label(rows, `linhas 1–${from - 1} não lidas`)
  parsed.forEach((l, i) => rows.push({ kind: 'ctx', num: l.num, src: 1, line: i }))
  if (range.partial || parsed.length >= READ_DEFAULT_LIMIT) label(rows, 'o resto do arquivo não foi lido')
  return view(rows, parsed.map((l) => l.text).join('\n'), null, { from, to, total: range.partial ? null : to })
}

export function readSummary(v: ReadView | null): string {
  const s = v?.shown
  if (!s) return 'Somente leitura'
  if (s.from === 1 && s.total !== null && s.to === s.total) return `Somente leitura · leu o arquivo inteiro (${s.total} ${s.total === 1 ? 'linha' : 'linhas'})`
  return `Somente leitura · leu as linhas ${s.from}–${s.to}${s.total !== null ? ` de ${s.total}` : ''}`
}
