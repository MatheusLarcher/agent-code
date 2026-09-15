import { constants, type Stats } from 'node:fs'
import { open, realpath, readdir, lstat, stat, type FileHandle } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'

const MAX_MARKDOWN_BYTES = 64 * 1024
const MAX_ROOT_MARKDOWN_TOTAL_BYTES = 8 * 1024 * 1024
const MAX_HEADINGS = 32
const MAX_HEADING_LENGTH = 160
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd'])

interface OutlineEntry {
  path: string
  depth: number
  kind: 'directory' | 'file' | 'symlink'
  /** The first three physical lines of nested Markdown, never parsed headings. */
  preview?: string[]
  content?: string
  marker?: string
}

function safeReason(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : 'unavailable'
  return code.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'unavailable'
}

function relativePath(cwd: string, absolutePath: string): string {
  return relative(cwd, absolutePath).split(sep).join('/')
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function stableFile(left: Stats, right: Stats): boolean {
  return sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
}

async function openVerifiedRegularFile(
  path: string,
  canonicalRoot: string
): Promise<{ handle: FileHandle; before: Stats }> {
  const resolved = await realpath(path)
  if (!pathInside(canonicalRoot, resolved) || resolved === canonicalRoot) {
    throw Object.assign(new Error('path escaped docs root'), { code: 'PATH_ESCAPE' })
  }
  const expected = await stat(resolved)
  if (!expected.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'NOT_REGULAR' })

  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const handle = await open(path, constants.O_RDONLY | noFollow)
  try {
    const before = await handle.stat()
    if (!before.isFile() || !sameFile(expected, before)) {
      throw Object.assign(new Error('file changed before open'), { code: 'PATH_RACE' })
    }
    return { handle, before }
  } catch (error) {
    await handle.close()
    throw error
  }
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

async function readMarkdownPreview(
  path: string,
  canonicalRoot: string
): Promise<{ preview: string[]; marker?: string }> {
  const { handle, before } = await openVerifiedRegularFile(path, canonicalRoot)
  try {
    // Nested Markdown is deliberately bounded: callers receive the path plus
    // the first three *physical* lines, not a heading-derived summary. Keep the
    // existing I/O ceiling so an unterminated giant first line cannot exhaust us.
    const buffer = Buffer.alloc(Math.min(before.size, MAX_MARKDOWN_BYTES))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const after = await handle.stat()
    if (!stableFile(before, after)) return { preview: [], marker: '[changed during read]' }
    const text = buffer.subarray(0, bytesRead)
    if (text.includes(0)) return { preview: [], marker: '[binary markdown omitted]' }
    const decoded = text.toString('utf8')
    // Never pass a truncated physical line as if it were documentation. If the
    // bounded scan cannot establish all first three lines, omit the preview
    // rather than violating the "first three physical lines" contract.
    if (before.size > bytesRead && (decoded.match(/\r\n|\r|\n/g) ?? []).length < 3) {
      return { preview: [], marker: '[first 3 physical lines exceed 64 KiB read limit]' }
    }
    return {
      preview: decoded.split(/\r\n|\r|\n/).slice(0, 3),
      ...(before.size > bytesRead ? { marker: '[first 64 KiB scanned]' } : {})
    }
  } finally {
    await handle.close()
  }
}

interface RootMarkdownBudget {
  remainingBytes: number
}

async function readRootMarkdown(
  path: string,
  canonicalRoot: string,
  budget: RootMarkdownBudget
): Promise<{ content?: string; marker?: string }> {
  const { handle, before } = await openVerifiedRegularFile(path, canonicalRoot)
  try {
    if (before.size > budget.remainingBytes) {
      return { marker: `[full content omitted: ${MAX_ROOT_MARKDOWN_TOTAL_BYTES / (1024 * 1024)} MiB root Markdown budget]` }
    }
    // Consume the budget before reading so binary/unstable files cannot bypass
    // the aggregate I/O bound by being discarded after allocation.
    budget.remainingBytes -= before.size

    const buffer = Buffer.alloc(before.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const after = await handle.stat()
    if (offset !== before.size || !stableFile(before, after)) return { marker: '[changed during read]' }
    if (buffer.includes(0)) return { marker: '[binary markdown omitted]' }
    return { content: buffer.toString('utf8') }
  } finally {
    await handle.close()
  }
}

async function walk(
  cwd: string,
  absoluteDir: string,
  canonicalRoot: string,
  depth: number,
  entries: OutlineEntry[],
  budget: RootMarkdownBudget
): Promise<void> {
  let children
  try {
    const current = await realpath(absoluteDir)
    if (!pathInside(canonicalRoot, current)) {
      entries.push({ path: relativePath(cwd, absoluteDir), depth, kind: 'directory', marker: '[outside docs root]' })
      return
    }
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
        await walk(cwd, absolutePath, canonicalRoot, depth + 1, entries, budget)
      } else {
        const entry: OutlineEntry = { path, depth, kind: 'file', marker: fileMarker(path) }
        if (MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase())) {
          try {
            if (depth === 1) {
              const result = await readRootMarkdown(absolutePath, canonicalRoot, budget)
              entry.content = result.content
              if (result.marker) entry.marker = result.marker
            } else {
              const result = await readMarkdownPreview(absolutePath, canonicalRoot)
              entry.preview = result.preview
              if (result.marker) entry.marker = result.marker
            }
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
  let canonicalRoot: string

  try {
    const stat = await lstat(docsDir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return '[PROJECT_DOCS_CONTEXT]\ndocs/ [not a directory]\n[/PROJECT_DOCS_CONTEXT]'
    }
    canonicalRoot = await realpath(docsDir)
  } catch (err) {
    const marker = safeReason(err) === 'ENOENT' ? '[not present]' : `[unavailable: ${safeReason(err)}]`
    return `[PROJECT_DOCS_CONTEXT]\ndocs/ ${marker}\n[/PROJECT_DOCS_CONTEXT]`
  }

  entries.push({ path: 'docs', depth: 0, kind: 'directory' })
  await walk(cwd, docsDir, canonicalRoot, 1, entries, { remainingBytes: MAX_ROOT_MARKDOWN_TOTAL_BYTES })

  const lines = [
    '[PROJECT_DOCS_CONTEXT]',
    'Fresh authoritative project documentation at request time. Root Markdown files are complete; nested Markdown files include their path and first three physical lines only.'
  ]
  for (const entry of entries) {
    const suffix = entry.kind === 'directory' ? '/' : ''
    const marker = entry.marker ? ` ${entry.marker}` : ''
    lines.push(`${'  '.repeat(entry.depth)}${entry.path.split('/').at(-1)}${suffix}${marker}`)
    if (entry.content !== undefined) {
      lines.push(`--- PROJECT DOC FILE: ${entry.path} ---`)
      lines.push(entry.content || '(empty markdown file)')
      lines.push(`--- END PROJECT DOC FILE: ${entry.path} ---`)
    }
    if (entry.preview !== undefined) {
      lines.push(`--- PROJECT DOC PREVIEW (first 3 physical lines): ${entry.path} ---`)
      lines.push(...entry.preview)
      lines.push(`--- END PROJECT DOC PREVIEW: ${entry.path} ---`)
    }
  }
  lines.push('[/PROJECT_DOCS_CONTEXT]')
  return lines.join('\n')
}
