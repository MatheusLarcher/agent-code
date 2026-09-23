import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { CodeBlock, extToLang } from './CodeBlock'
import { IconFolder } from './Icons'
import { Markdown } from './Markdown'

/**
 * The "Janela de Arquivo": renders a local file the right way for its type —
 * Markdown formatted, PDFs in the native viewer, images, spreadsheets as tables,
 * and everything else as syntax-highlighted text. Binary types load their bytes
 * via the `readFileBytes` IPC (base64); text types use `readFile`.
 */

const IMG_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml'
}

const SHEET_EXTS = new Set(['xlsx', 'xls', 'xlsb', 'xlsm', 'ods', 'csv', 'tsv'])

/** Lowercase extension of a file URL (no dot), or '' if none. */
function extOf(url: string): string {
  const m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(url)
  return m ? m[1].toLowerCase() : ''
}

/** Decode base64 into raw bytes (for blobs / SheetJS). */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

function Placeholder({ error, loading }: { error?: string; loading?: boolean }): JSX.Element {
  return (
    <div className="browser-placeholder">
      <p style={error ? { color: '#ef4444' } : undefined}>
        {error || (loading ? 'Carregando arquivo…' : '')}
      </p>
    </div>
  )
}

/** Load a file as base64 bytes via IPC (re-runs when the path changes). */
function useFileBytes(path: string): { base64: string | null; error: string | null } {
  const [base64, setBase64] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setBase64(null)
    setError(null)
    window.api
      .readFileBytes(path)
      .then((r) => {
        if (!active) return
        if (r.ok) setBase64(r.base64)
        else setError(r.error)
      })
      .catch((e) => {
        if (active) setError(String(e))
      })
    return () => {
      active = false
    }
  }, [path])
  return { base64, error }
}

/** PDF — rendered by Chromium's built-in viewer via a blob URL in an iframe. */
function PdfView({ path }: { path: string }): JSX.Element {
  const { base64, error } = useFileBytes(path)
  const blobUrl = useMemo(() => {
    if (!base64) return ''
    const buf = b64ToBytes(base64).buffer as ArrayBuffer
    return URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }))
  }, [base64])
  useEffect(() => () => void (blobUrl && URL.revokeObjectURL(blobUrl)), [blobUrl])
  if (error) return <Placeholder error={error} />
  if (!blobUrl) return <Placeholder loading />
  return <iframe title="PDF" src={blobUrl} style={{ border: 'none', width: '100%', height: '100%' }} />
}

/** Image — shown as a centered, contained <img> from a data URL. */
function ImageView({ path, kind }: { path: string; kind: string }): JSX.Element {
  const { base64, error } = useFileBytes(path)
  if (error) return <Placeholder error={error} />
  if (!base64) return <Placeholder loading />
  const mime = IMG_MIME[kind] || 'application/octet-stream'
  return (
    <div className="file-preview-container fp-center">
      <img
        src={`data:${mime};base64,${base64}`}
        alt={path}
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
      />
    </div>
  )
}

/** Spreadsheet (xlsx/xls/ods/csv…) — parsed with SheetJS, one tab per sheet. */
function SheetView({ path }: { path: string }): JSX.Element {
  const { base64, error } = useFileBytes(path)
  const [sheet, setSheet] = useState(0)
  useEffect(() => setSheet(0), [path])
  const wb = useMemo(() => {
    if (!base64) return null
    try {
      return XLSX.read(b64ToBytes(base64), { type: 'array' })
    } catch {
      return null
    }
  }, [base64])

  if (error) return <Placeholder error={error} />
  if (!base64) return <Placeholder loading />
  if (!wb || !wb.SheetNames.length) return <Placeholder error="Não foi possível ler a planilha." />

  const idx = Math.min(sheet, wb.SheetNames.length - 1)
  const name = wb.SheetNames[idx]
  const html = XLSX.utils.sheet_to_html(wb.Sheets[name])
  return (
    <div className="file-preview-container fp-sheet">
      {wb.SheetNames.length > 1 && (
        <div className="fp-sheet-tabs">
          {wb.SheetNames.map((n, i) => (
            <button
              key={n}
              className={`fp-sheet-tab ${i === idx ? 'active' : ''}`}
              onClick={() => setSheet(i)}
            >
              {n}
            </button>
          ))}
        </div>
      )}
      <div className="fp-sheet-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

/** Text/markdown — read as UTF-8; markdown renders formatted, the rest highlighted. */
function TextView({ url, path }: { url: string; path: string }): JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setContent(null)
    setError(null)
    window.api
      .readFile(path)
      .then((res) => {
        if (!active) return
        if (res.startsWith('Erro ao ler arquivo:')) setError(res)
        else setContent(res)
      })
      .catch((e) => {
        if (active) setError(String(e))
      })
    return () => {
      active = false
    }
  }, [path])

  if (error) return <Placeholder error={error} />
  if (content === null) return <Placeholder loading />
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(url)
  return (
    <div
      className="file-preview-container"
      style={{ padding: '16px', overflow: 'auto', height: '100%', background: '#1e1e1e', color: '#e8e6e3' }}
    >
      {isMarkdown ? <Markdown text={content} /> : <CodeBlock code={content} language={extToLang(url)} />}
    </div>
  )
}

export function FilePreview({ url, onPick }: { url: string; onPick: () => void }): JSX.Element {
  if (!url)
    return (
      <div className="browser-placeholder">
        <p>Nenhum arquivo aberto.</p>
        <button className="btn primary" onClick={onPick}>
          <IconFolder size={14} /> Selecionar arquivo do projeto
        </button>
      </div>
    )

  // file:/// URL → OS path the IPC layer reads (the url was built without
  // percent-encoding, so no decode is needed).
  const path = url.replace(/^file:\/\/\//i, '').replace(/\//g, '\\')
  const ext = extOf(url)
  if (ext === 'pdf') return <PdfView path={path} />
  if (IMG_MIME[ext]) return <ImageView path={path} kind={ext} />
  if (SHEET_EXTS.has(ext)) return <SheetView path={path} />
  return <TextView url={url} path={path} />
}
