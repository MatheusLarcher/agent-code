import { open, readdir, lstat } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'

const MAX_MARKDOWN_BYTES = 64 * 1024
const MAX_HEADINGS = 32
const MAX_HEADING_LENGTH = 160
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd'])

interface OutlineEntry {
  path: string
  depth: number
  kind: 'directory' | 'file' | 'symlink'
  headings?: string[]
  marker?: string
}

function safeReason(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : 'unavailable'
  return code.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'unavailable'
}

function relativePath(cwd: string, absolutePath: string): string {
  return relative(cwd, absolutePath).split(sep).join('/')
}

function fileMarker(path: string): string {
  const ext = extname(path).toLowerCase()
  if (MARKDOWN_EXTENSIONS.has(ext)) return ''
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'].includes(ext)) return '[image]'
  if (ext === '.pdf') return '[pdf]'
  if (ext === '.json') return '[json]'
  if (['.yaml', '.yml'].includes(ext)) return '[yaml]'
  if (['.txt', '.csv', '.log'].includes(ext)) return '[text]'
  return ext ? `[${ext.slice(1)}]` : '[file]'
}

export function extractMarkdownHeadings(text: string, maxHeadings: number = MAX_HEADINGS): string[] {
  const headings: string[] = []
  const lines = text.split(/\r?\n/)
  let fenced = false
  let fenceChar = ''

  for (let i = 0; i < lines.length && headings.length < maxHeadings; i++) {
    const line = lines[i]
    const fence = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      const char = fence[1][0]
      if (!fenced) {
        fenced = true
        fenceChar = char
      } else if (char === fenceChar) {
        fenced = false
        fenceChar = ''
      }
      continue
    }
    if (fenced) continue

    const atx = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (atx) {
      const title = atx[2].replace(/\s+/g, ' ').trim().slice(0, MAX_HEADING_LENGTH)
      if (title) headings.push(`${atx[1]} ${title}`)
      continue
    }

    if (i + 1 < lines.length) {
      const underline = lines[i + 1].match(/^\s{0,3}(=+|-+)\s*$/)
      const title = line.replace(/\s+/g, ' ').trim()
      if (underline && title) {
        headings.push(`${underline[1][0] === '=' ? '#' : '##'} ${title.slice(0, MAX_HEADING_LENGTH)}`)
        i++
      }
    }
  }

  return headings
}

async function readMarkdownHeadings(path: string): Promise<{ headings: string[]; marker?: string }> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(MAX_MARKDOWN_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const stat = await handle.stat()
    const found = extractMarkdownHeadings(buffer.subarray(0, bytesRead).toString('utf8'), MAX_HEADINGS + 1)
    const limits: string[] = []
    if (stat.size > bytesRead) limits.push('first 64 KiB scanned')
    if (found.length > MAX_HEADINGS) limits.push(`first ${MAX_HEADINGS} headings shown`)
    return {
      headings: found.slice(0, MAX_HEADINGS),
      marker: limits.length ? `[heading metadata limited: ${limits.join('; ')}]` : undefined
    }
  } finally {
    await handle.close()
  }
}

async function walk(cwd: string, absoluteDir: string, depth: number, entries: OutlineEntry[]): Promise<void> {
  let children
  try {
    children = await readdir(absoluteDir, { withFileTypes: true })
  } catch (err) {
    entries.push({ path: relativePath(cwd, absoluteDir), depth, kind: 'directory', marker: `[unreadable: ${safeReason(err)}]` })
    return
  }

  children.sort((a, b) => a.name.localeCompare(b.name, 'en'))
  for (const child of children) {
    const absolutePath = join(absoluteDir, child.name)
    const path = relativePath(cwd, absolutePath)
    try {
      const stat = await lstat(absolutePath)
      if (stat.isSymbolicLink()) {
        entries.push({ path, depth, kind: 'symlink', marker: '[symlink]' })
      } else if (stat.isDirectory()) {
        entries.push({ path, depth, kind: 'directory' })
        await walk(cwd, absolutePath, depth + 1, entries)
      } else {
        const entry: OutlineEntry = { path, depth, kind: 'file', marker: fileMarker(path) }
        if (MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase())) {
          try {
            const result = await readMarkdownHeadings(absolutePath)
            entry.headings = result.headings
            if (result.marker) entry.marker = result.marker
          } catch (err) {
            entry.marker = `[unreadable: ${safeReason(err)}]`
          }
        }
        entries.push(entry)
      }
    } catch (err) {
      entries.push({ path, depth, kind: 'file', marker: `[unreadable: ${safeReason(err)}]` })
    }
  }
}

export async function buildProjectOutline(cwd: string): Promise<string> {
  const docsDir = join(cwd, 'docs')
  const entries: OutlineEntry[] = []

  try {
    const stat = await lstat(docsDir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return '[PROJECT_DOCS_OUTLINE]\ndocs/ [not a directory]\n[/PROJECT_DOCS_OUTLINE]'
    }
  } catch (err) {
    const marker = safeReason(err) === 'ENOENT' ? '[not present]' : `[unavailable: ${safeReason(err)}]`
    return `[PROJECT_DOCS_OUTLINE]\ndocs/ ${marker}\n[/PROJECT_DOCS_OUTLINE]`
  }

  entries.push({ path: 'docs', depth: 0, kind: 'directory' })
  await walk(cwd, docsDir, 1, entries)

  const lines = [
    '[PROJECT_DOCS_OUTLINE]',
    'Fresh recursive outline of project docs at message dispatch time. Paths are relative; full file contents are not included.'
  ]
  for (const entry of entries) {
    const suffix = entry.kind === 'directory' ? '/' : ''
    const marker = entry.marker ? ` ${entry.marker}` : ''
    lines.push(`${'  '.repeat(entry.depth)}${entry.path.split('/').at(-1)}${suffix}${marker}`)
    for (const heading of entry.headings ?? []) {
      lines.push(`${'  '.repeat(entry.depth + 1)}${heading}`)
    }
  }
  lines.push('[/PROJECT_DOCS_OUTLINE]')
  return lines.join('\n')
}
