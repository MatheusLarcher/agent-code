/** Display helpers for non-image file attachments (chip icon + size). */
import { ARCHIVE_EXTS, CODE_EXTS, EXCEL_EXTS, PDF_EXTS, PPT_EXTS, TEXT_EXTS, WORD_EXTS } from '@shared/mime'

/** A file's short type label + a kind used to color its badge. */
export interface FileMeta {
  /** Up-to-4-char uppercase extension, e.g. "PDF", "XLSX". */
  ext: string
  /** Category used by CSS to tint the badge. */
  kind: 'pdf' | 'doc' | 'xls' | 'ppt' | 'txt' | 'zip' | 'code' | 'file'
}

export function fileMeta(name: string): FileMeta {
  const e = (name.split('.').pop() || '').toLowerCase()
  const kind: FileMeta['kind'] =
    PDF_EXTS.includes(e) ? 'pdf'
    : WORD_EXTS.includes(e) ? 'doc'
    : EXCEL_EXTS.includes(e) ? 'xls'
    : PPT_EXTS.includes(e) ? 'ppt'
    : TEXT_EXTS.includes(e) ? 'txt'
    : ARCHIVE_EXTS.includes(e) ? 'zip'
    : CODE_EXTS.includes(e) ? 'code'
    : 'file'
  return { ext: e ? e.toUpperCase().slice(0, 4) : 'FILE', kind }
}

/** Human-readable byte size, e.g. "24 KB". */
export function fmtSize(n: number): string {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
