/**
 * Regras da tabela do Preview — PURO (sem React): número em pt-BR ou en,
 * coluna numérica, ordenação, filtro e paginação. O TableView só desenha.
 */

/** Linhas por página da tabela. */
export const PAGE_SIZE = 100

/** 'auto': aceita 1.234,56 (pt-BR) e 1,234.56 (en); 'dot': só ponto decimal (números vindos de JSON). */
export type DecimalMode = 'auto' | 'dot'

/** Formato de número de uma coluna (null = não é numérica). */
export type NumberFormat = 'pt' | 'en'

// pt-BR: 1.234,56 · 1234,56 · 12 — en: 1,234.56 · 1234.56 · 12
const PT = /^-?(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/
const EN = /^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/

/** Tira moeda, porcentagem e espaços em volta: "R$ 1.234,56" → "1.234,56". */
function bare(cell: string): string {
  return cell
    .trim()
    .replace(/^(R\$|US\$|\$|€)\s*/i, '')
    .replace(/\s*%$/, '')
    .replace(/[\s ]/g, '')
}

/** O número da célula no formato dado; NaN se não for número nesse formato. */
export function parseNumber(cell: string, format: NumberFormat): number {
  const s = bare(cell)
  if (format === 'pt') return PT.test(s) ? Number(s.replace(/\./g, '').replace(',', '.')) : NaN
  return EN.test(s) ? Number(s.replace(/,/g, '')) : NaN
}

/**
 * Formato numérico da coluna: todas as células não vazias são número no mesmo
 * formato. Quando servem os dois ("1.234", "12"), vale o pt-BR (planilhas
 * daqui) — exceto no modo 'dot', em que só o ponto decimal conta.
 */
export function columnNumberFormat(rows: string[][], col: number, mode: DecimalMode = 'auto'): NumberFormat | null {
  let pt = mode === 'auto'
  let en = true
  let seen = false
  for (const row of rows) {
    const raw = row[col]
    if (raw == null || raw.trim() === '') continue
    seen = true
    const s = bare(raw)
    if (pt && !PT.test(s)) pt = false
    if (en && !EN.test(s)) en = false
    if (!pt && !en) return null
  }
  if (!seen) return null
  return pt ? 'pt' : 'en'
}

export type SortDir = 'asc' | 'desc'
export interface SortState {
  col: number
  dir: SortDir
}

/** Clique no cabeçalho: crescente → decrescente → sem ordem (outra coluna recomeça em crescente). */
export function nextSort(current: SortState | null, col: number): SortState | null {
  if (!current || current.col !== col) return { col, dir: 'asc' }
  return current.dir === 'asc' ? { col, dir: 'desc' } : null
}

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' })

/**
 * Índices de `rows` na ordem pedida (estável). Célula vazia vai sempre para o fim,
 * nos dois sentidos. `format` numérico compara como número; senão, texto pt-BR.
 */
export function sortIndices(rows: string[][], indices: number[], sort: SortState | null, format: NumberFormat | null): number[] {
  if (!sort) return indices
  const { col, dir } = sort
  const sign = dir === 'asc' ? 1 : -1
  const keyed = indices.map((i) => {
    const cell = rows[i][col] ?? ''
    const empty = cell.trim() === ''
    return { i, empty, cell, num: format && !empty ? parseNumber(cell, format) : NaN }
  })
  keyed.sort((a, b) => {
    if (a.empty !== b.empty) return a.empty ? 1 : -1
    if (a.empty) return a.i - b.i
    const diff = format ? a.num - b.num : collator.compare(a.cell, b.cell)
    return diff !== 0 ? diff * sign : a.i - b.i
  })
  return keyed.map((k) => k.i)
}

/** Minúsculo e sem acento, para o filtro achar "acao" em "Ação". */
export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/**
 * Texto normalizado de cada linha, feito uma vez por aba: o filtro roda a cada
 * tecla e não pode normalizar 5.000 × 200 células de novo. O separador \u0001
 * impede que o filtro case pedaços de duas células vizinhas.
 */
export function searchIndex(rows: string[][]): string[] {
  return rows.map((row) => normalizeText(row.join('\u0001')))
}

/** Índices das linhas em que alguma célula contém o filtro (sem diferenciar maiúscula e acento). */
export function filterIndices(index: string[], query: string): number[] {
  const all = index.map((_, i) => i)
  const q = normalizeText(query.trim())
  if (!q) return all
  return all.filter((i) => index[i].includes(q))
}

/** Total de páginas (pelo menos 1, para "página 1 de 1" numa tabela vazia). */
export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE))
}

/** Número no jeito brasileiro: 5000 → "5.000". */
export function fmtInt(n: number): string {
  return n.toLocaleString('pt-BR')
}
