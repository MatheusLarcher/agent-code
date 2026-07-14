// Extension/MIME helpers shared by the composer (deciding what a pasted line
// is) and main (resolving/downloading it). Single source of truth so the two
// sides can't disagree on what counts as a "file".

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']
const DOC_EXTS = ['pdf', 'doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'csv', 'ods', 'ppt', 'pptx', 'odp']
const TEXT_EXTS = ['txt', 'md', 'log']
const ARCHIVE_EXTS = ['zip', 'rar', '7z', 'tar', 'gz']
const CODE_EXTS = [
  'js', 'ts', 'tsx', 'jsx', 'json', 'py', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'rb', 'php',
  'html', 'css', 'xml', 'yml', 'yaml', 'sh'
]

/** Every extension (no dot, lowercase) recognized as "this is a file", for
 *  paste-detection purposes. */
export const KNOWN_FILE_EXTS = new Set([...IMAGE_EXTS, ...DOC_EXTS, ...TEXT_EXTS, ...ARCHIVE_EXTS, ...CODE_EXTS])

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed'
}

/** Extension (no dot, lowercase) from a file name or URL path, e.g. "pdf". */
export function extOf(nameOrPath: string): string {
  const clean = nameOrPath.split(/[?#]/)[0]
  const base = clean.split(/[\\/]/).pop() || ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** Best-effort MIME type for an extension; falls back to a generic binary type. */
export function mimeForExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] || 'application/octet-stream'
}

export function isImageExt(ext: string): boolean {
  return IMAGE_EXTS.includes(ext.toLowerCase())
}

/** A single pasted line that looks like a Windows, UNC, or POSIX absolute path. */
export function looksLikeLocalPath(line: string): boolean {
  const s = line.trim()
  if (!s || /\s/.test(s)) return false
  return /^[a-zA-Z]:[\\/]/.test(s) || /^\\\\[^\\]+\\/.test(s) || s.startsWith('/')
}

/** A single pasted line that is an http(s) URL ending (before any query/hash)
 *  in a known file extension — a bare page URL doesn't count. */
export function looksLikeFileUrl(line: string): boolean {
  const s = line.trim()
  if (!/^https?:\/\/\S+$/i.test(s)) return false
  return KNOWN_FILE_EXTS.has(extOf(s))
}
