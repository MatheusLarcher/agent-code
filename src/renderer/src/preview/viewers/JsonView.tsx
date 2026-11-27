/**
 * JSON do Preview: lista de objetos vira tabela (colunas = todas as chaves),
 * o resto vira código indentado. JSON que não dá para ler aparece como texto,
 * com um aviso. .jsonl = um valor por linha.
 */
import { useMemo } from 'react'
import { PREVIEW_LIMITS, type PreviewSheet } from '@shared/preview'
import { CodeView } from './CodeView'
import { TableView } from './TableView'
import { ViewerNotice } from './ViewerNotice'
import { fmtInt } from './tableData'
import './viewers.css'

/** Objeto dentro de célula aparece como JSON curto, cortado aqui. */
const CELL_JSON_MAX = 200

type Parsed = { ok: true; value: unknown } | { ok: false }

/**
 * Lê o texto como JSON (ou JSONL: um valor por linha, vira uma lista).
 * Arquivo cortado no JSONL: a última linha, quebrada no meio, é descartada.
 */
export function parseJson(text: string, jsonl: boolean, truncated = false): Parsed {
  if (!jsonl) {
    try {
      return { ok: true, value: JSON.parse(text) }
    } catch {
      return { ok: false }
    }
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  const values: unknown[] = []
  for (let i = 0; i < lines.length; i++) {
    try {
      values.push(JSON.parse(lines[i]))
    } catch {
      if (truncated && i === lines.length - 1) break
      return { ok: false }
    }
  }
  return { ok: true, value: values }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v !== 'object') return String(v)
  const s = JSON.stringify(v)
  return s.length > CELL_JSON_MAX ? `${s.slice(0, CELL_JSON_MAX - 1)}…` : s
}

export interface JsonTable {
  rows: string[][]
  cutCols: boolean
  /** Passou de `maxRows` objetos: só os primeiros viraram linha (como na planilha). */
  cutRows: boolean
}

/**
 * Lista de objetos → linhas da tabela (linha 0 = cabeçalho com todas as chaves,
 * na ordem em que aparecem). null quando o valor não é uma lista de objetos.
 */
export function jsonToTable(
  value: unknown,
  maxCols: number = PREVIEW_LIMITS.tableCols,
  maxRows: number = PREVIEW_LIMITS.tableRows
): JsonTable | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isPlainObject)) return null
  const kept = value.length > maxRows ? value.slice(0, maxRows) : value
  const keys: string[] = []
  const seen = new Set<string>()
  for (const obj of kept) {
    for (const k of Object.keys(obj)) {
      if (!seen.has(k)) {
        seen.add(k)
        keys.push(k)
      }
    }
  }
  const cols = keys.slice(0, maxCols)
  const rows = [cols, ...kept.map((obj) => cols.map((k) => cellText(obj[k])))]
  return { rows, cutCols: keys.length > cols.length, cutRows: kept.length < value.length }
}

export interface JsonViewProps {
  text: string
  /** .jsonl: um valor por linha. */
  jsonl?: boolean
  truncated?: boolean
}

export function JsonView({ text, jsonl = false, truncated = false }: JsonViewProps): JSX.Element {
  const parsed = useMemo(() => parseJson(text, jsonl, truncated), [text, jsonl, truncated])
  const table = useMemo(() => (parsed.ok ? jsonToTable(parsed.value) : null), [parsed])
  const pretty = useMemo(
    () => (parsed.ok && !table ? JSON.stringify(parsed.value, null, 2) ?? '' : ''),
    [parsed, table]
  )
  // Mesma lista enquanto a tabela for a mesma: os memos do TableView (ordem,
  // busca, formatos) não refazem tudo a cada render.
  const sheets = useMemo<PreviewSheet[] | null>(
    () => (table ? [{ name: 'JSON', rows: table.rows, truncated: table.cutRows }] : null),
    [table]
  )

  if (!parsed.ok) {
    const notice = truncated
      ? 'O arquivo foi cortado, então não dá para ler como JSON: mostrando o texto como está.'
      : 'Não deu para ler como JSON: mostrando o texto como está.'
    return <CodeView text={text} lang="json" truncated={truncated} notice={notice} />
  }

  if (table && sheets) {
    return (
      <div className="pv-viewer">
        {truncated && (
          <ViewerNotice>
            Arquivo grande: mostrando só as linhas dos primeiros {fmtInt(PREVIEW_LIMITS.textBytes / (1024 * 1024))} MB.
          </ViewerNotice>
        )}
        {table.cutCols && <ViewerNotice>Mostrando só as primeiras {PREVIEW_LIMITS.tableCols} colunas.</ViewerNotice>}
        <div className="pv-fill">
          <TableView sheets={sheets} decimal="dot" firstRow={1} />
        </div>
      </div>
    )
  }

  return <CodeView text={pretty} lang="json" truncated={truncated} />
}
