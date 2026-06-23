/** Display helpers for non-image file attachments (chip icon + size). */

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
    e === 'pdf' ? 'pdf'
    : ['doc', 'docx', 'odt', 'rtf'].includes(e) ? 'doc'
    : ['xls', 'xlsx', 'csv', 'ods'].includes(e) ? 'xls'
    : ['ppt', 'pptx', 'odp'].includes(e) ? 'ppt'
    : ['txt', 'md', 'log'].includes(e) ? 'txt'
    : ['zip', 'rar', '7z', 'tar', 'gz'].includes(e) ? 'zip'
    : ['js', 'ts', 'tsx', 'jsx', 'json', 'py', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'rb', 'php', 'html', 'css', 'xml', 'yml', 'yaml', 'sh'].includes(e) ? 'code'
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
