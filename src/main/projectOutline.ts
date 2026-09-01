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
  headings?: string[]
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

async function readMarkdownHeadings(
  path: string,
  canonicalRoot: string
): Promise<{ headings: string[]; marker?: string }> {
  const { handle, before } = await openVerifiedRegularFile(path, canonicalRoot)
  try {
    const buffer = Buffer.alloc(MAX_MARKDOWN_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const after = await handle.stat()
    if (!stableFile(before, after)) return { headings: [], marker: '[changed during read]' }
    const found = extractMarkdownHeadings(buffer.subarray(0, bytesRead).toString('utf8'), MAX_HEADINGS + 1)
    const limits: string[] = []
    if (before.size > bytesRead) limits.push('first 64 KiB scanned')
    if (found.length > MAX_HEADINGS) limits.push(`first ${MAX_HEADINGS} headings shown`)
    return {
      headings: found.slice(0, MAX_HEADINGS),
      marker: limits.length ? `[heading metadata limited: ${limits.join('; ')}]` : undefined
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
              const result = await readMarkdownHeadings(absolutePath, canonicalRoot)
              entry.headings = result.headings
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
    'Fresh authoritative project documentation at message dispatch time. Replace earlier project-docs blocks with this one. Root Markdown files are complete; nested Markdown files include headings only.'
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
    for (const heading of entry.headings ?? []) {
      lines.push(`${'  '.repeat(entry.depth + 1)}${heading}`)
    }
  }
  lines.push('[/PROJECT_DOCS_CONTEXT]')
  return lines.join('\n')
}
