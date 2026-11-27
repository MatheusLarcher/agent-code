/**
 * Tabela do Preview (planilha, csv e JSON em lista): abas da planilha, filtro
 * em todas as colunas, ordenar pelo cabeçalho, paginação de 100 linhas.
 * Só a página atual vai para o DOM. As regras ficam em tableData.ts.
 */
import { useMemo, useState } from 'react'
import { PREVIEW_LIMITS, type PreviewSheet } from '@shared/preview'
import { IconChevronDown, IconChevronLeft, IconChevronRight } from '../../components/Icons'
import { ViewerNotice } from './ViewerNotice'
import {
  PAGE_SIZE,
  columnNumberFormat,
  filterIndices,
  fmtInt,
  nextSort,
  pageCount,
  searchIndex,
  sortIndices,
  type DecimalMode,
  type SortState
} from './tableData'
import './viewers.css'

export interface TableViewProps {
  sheets: PreviewSheet[]
  /** 'dot' quando os números vêm de JSON (1.234 é um vírgula dois três quatro). */
  decimal?: DecimalMode
  /** Número mostrado na 1ª linha de dados: 2 na planilha (o cabeçalho é a linha 1, como no Excel), 1 no JSON. */
  firstRow?: number
}

export function TableView({ sheets, decimal = 'auto', firstRow = 2 }: TableViewProps): JSX.Element {
  const [active, setActive] = useState(0)
  const current = Math.min(active, Math.max(0, sheets.length - 1))
  const sheet = sheets[current]
  return (
    <div className="pv-table">
      {sheets.length > 1 && (
        <div className="pv-sheet-tabs pv-scroll" role="tablist" aria-label="Abas da planilha">
          {sheets.map((s, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === current}
              className={`pv-sheet-tab${i === current ? ' active' : ''}`}
              onClick={() => setActive(i)}
            >
              {s.name || `Aba ${i + 1}`}
            </button>
          ))}
        </div>
      )}
      {sheet ? (
        // key: trocar de aba zera filtro, ordem e página.
        <SheetTable key={current} sheet={sheet} decimal={decimal} firstRow={firstRow} />
      ) : (
        <p className="pv-empty">Esta planilha não tem abas.</p>
      )}
    </div>
  )
}

function SheetTable({ sheet, decimal, firstRow }: { sheet: PreviewSheet; decimal: DecimalMode; firstRow: number }): JSX.Element {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortState | null>(null)
  const [page, setPage] = useState(0)

  const header = sheet.rows[0] ?? []
  const body = useMemo(() => sheet.rows.slice(1), [sheet])
  const colCount = useMemo(() => sheet.rows.reduce((max, r) => Math.max(max, r.length), 0), [sheet])
  const formats = useMemo(
    () => Array.from({ length: colCount }, (_, c) => columnNumberFormat(body, c, decimal)),
    [body, colCount, decimal]
  )
  const index = useMemo(() => searchIndex(body), [body])
  const filtered = useMemo(() => filterIndices(index, query), [index, query])
  const ordered = useMemo(
    () => sortIndices(body, filtered, sort, sort ? formats[sort.col] : null),
    [body, filtered, sort, formats]
  )

  const pages = pageCount(ordered.length)
  const pageNow = Math.min(page, pages - 1)
  const visible = ordered.slice(pageNow * PAGE_SIZE, (pageNow + 1) * PAGE_SIZE)

  if (colCount === 0) return <p className="pv-empty">Esta aba está vazia.</p>

  const count =
    filtered.length === body.length
      ? `${fmtInt(body.length)} ${body.length === 1 ? 'linha' : 'linhas'}`
      : `${fmtInt(filtered.length)} de ${fmtInt(body.length)} linhas`

  return (
    <>
      <div className="pv-table-bar">
        <label className="pv-filter">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <line x1="16" y1="16" x2="20.5" y2="20.5" />
          </svg>
          <input
            type="text"
            value={query}
            placeholder="Filtrar linhas"
            aria-label="Filtrar linhas"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(0)
            }}
          />
        </label>
        <span className="pv-count" aria-live="polite">
          {count}
        </span>
      </div>
      {sheet.truncated && (
        <ViewerNotice>
          A aba passa do limite: mostrando as primeiras {fmtInt(PREVIEW_LIMITS.tableRows)} linhas e até{' '}
          {PREVIEW_LIMITS.tableCols} colunas.
        </ViewerNotice>
      )}
      <div className="pv-table-scroll pv-scroll">
        <table className="pv-grid">
          <thead>
            <tr>
              <th className="pv-rownum" scope="col" aria-label="Linha">
                #
              </th>
              {Array.from({ length: colCount }, (_, c) => {
                const dir = sort?.col === c ? sort.dir : null
                const label = header[c]?.trim() || `Coluna ${c + 1}`
                return (
                  <th
                    key={c}
                    scope="col"
                    aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
                    className={formats[c] ? 'num' : undefined}
                  >
                    <button
                      type="button"
                      className={`pv-sort${dir ? ` ${dir}` : ''}`}
                      title={`Ordenar por ${label}`}
                      onClick={() => {
                        setSort(nextSort(sort, c))
                        setPage(0)
                      }}
                    >
                      <span className="pv-sort-label">{label}</span>
                      <IconChevronDown size={12} className="pv-sort-icon" aria-hidden="true" />
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((i) => {
              const row = body[i]
              return (
                <tr key={i}>
                  {/* Número da linha na origem: segue a linha mesmo com filtro e ordem. */}
                  <td className="pv-rownum">{i + firstRow}</td>
                  {Array.from({ length: colCount }, (_, c) => (
                    <td key={c} className={formats[c] ? 'num' : undefined}>
                      {row[c] ?? ''}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
        {visible.length === 0 && (
          <p className="pv-empty">{body.length === 0 ? 'Só o cabeçalho, sem linhas.' : 'Nenhuma linha com esse texto.'}</p>
        )}
      </div>
      {pages > 1 && (
        <div className="pv-pager">
          <button type="button" className="pv-btn" disabled={pageNow === 0} onClick={() => setPage(pageNow - 1)}>
            <IconChevronLeft size={14} aria-hidden="true" />
            Anterior
          </button>
          <span className="pv-page">
            Página {fmtInt(pageNow + 1)} de {fmtInt(pages)}
          </span>
          <button type="button" className="pv-btn" disabled={pageNow >= pages - 1} onClick={() => setPage(pageNow + 1)}>
            Próxima
            <IconChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  )
}
