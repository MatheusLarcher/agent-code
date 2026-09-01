import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

/**
 * Walks the memories folder — including SUBFOLDERS, which the user uses to group
 * memories by context (a `2D/` folder means "these are about 2D"). Both the
 * session hint and the curator's index reconciliation read the tree from here so
 * a memory filed under a folder is never invisible.
 */

export interface MemoryCatalogFile {
  relPath: string
  content: string
  modifiedAtMs: number
  sizeBytes: number
}

export interface MemoryCatalogSnapshot {
  rootDir: string
  files: MemoryCatalogFile[]
  catalog: string
  /** Content fingerprint of the exact files included in this snapshot. */
  filesystemVersion: string
  version: string
}

interface MemoryFileMetadata {
  relPath: string
  fullPath: string
  modifiedAtMs: number
  sizeBytes: number
}

/** All Markdown files that form persistent memory, including the root index.
 * Symlinks and hidden entries are skipped so the catalog cannot escape its root. */
function listMemoryFileMetadata(dir: string): MemoryFileMetadata[] {
  const out: MemoryFileMetadata[] = []
  const walk = (current: string, folders: string[]): void => {
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath, [...folders, entry.name])
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      try {
        const stat = statSync(fullPath)
        out.push({
          relPath: [...folders, entry.name].join('/'),
          fullPath,
          modifiedAtMs: stat.mtimeMs,
          sizeBytes: stat.size
        })
      } catch {
        // A file can disappear while the tree is being scanned.
      }
    }
  }
  walk(dir, [])
  return out
}

function updateMemoryHash(
  hash: ReturnType<typeof createHash>,
  relPath: string,
  content: string
): void {
  hash.update(relPath).update('\0').update(content, 'utf8').update('\0')
}

/** Content signature checked before every user dispatch. Reading the bodies is
 * intentional: cloud sync can preserve both size and timestamp while replacing a
 * memory, and that change must still invalidate the authoritative catalog. */
export function memoryCatalogFilesystemVersion(dir: string): string {
  const hash = createHash('sha256').update(dir).update('\0')
  for (const metadata of listMemoryFileMetadata(dir)) {
    try {
      const content = readFileSync(metadata.fullPath, 'utf8')
      if (content.includes('\0')) continue
      updateMemoryHash(hash, metadata.relPath, content)
    } catch {
      // A file can disappear or become unreadable while the tree is hashed.
    }
  }
  return hash.digest('hex')
}

export function renderMemoryCatalog(files: MemoryCatalogFile[], rootDir = ''): string {
  const entries = files.map(
    (file) => `--- MEMORY FILE: ${file.relPath} ---\n${file.content.trim() || '(empty memory file)'}`
  )
  return `[AUTHORITATIVE PERSISTENT MEMORY CATALOG]
This is the complete persistent-memory snapshot for this user at conversation startup. Consider every
memory below when handling requests. The configured memories directory is:
${rootDir || '(not specified)'}
Paths below are relative to that directory. A later
[PERSISTENT_MEMORY_UPDATE] replaces this entire catalog; do not combine stale entries with the replacement.

${entries.length > 0 ? entries.join('\n\n') : '(no persistent memory files are currently available)'}
[/AUTHORITATIVE PERSISTENT MEMORY CATALOG]`
}

/** Reads every Markdown memory only when a conversation starts or metadata changed. */
export function createMemoryCatalogSnapshot(dir: string): MemoryCatalogSnapshot {
  const files: MemoryCatalogFile[] = []
  for (const metadata of listMemoryFileMetadata(dir)) {
    try {
      const content = readFileSync(metadata.fullPath, 'utf8')
      if (content.includes('\0')) continue
      files.push({
        relPath: metadata.relPath,
        content,
        modifiedAtMs: metadata.modifiedAtMs,
        sizeBytes: metadata.sizeBytes
      })
    } catch {
      // A file can disappear or become unreadable between metadata and content scans.
    }
  }
  const catalog = renderMemoryCatalog(files, dir)
  const hash = createHash('sha256').update(dir).update('\0')
  for (const file of files) updateMemoryHash(hash, file.relPath, file.content)
  const filesystemVersion = hash.digest('hex')
  return {
    rootDir: dir,
    files,
    catalog,
    filesystemVersion,
    version: filesystemVersion
  }
}

export function renderMemoryCatalogUpdate(snapshot: MemoryCatalogSnapshot): string {
  return `[PERSISTENT_MEMORY_UPDATE]
Persistent-memory files changed after this conversation started. Replace every earlier persistent-memory
catalog with the complete authoritative snapshot below. Do not mention this automatic refresh to the user
unless it blocks the task.

${snapshot.catalog}
[/PERSISTENT_MEMORY_UPDATE]`
}

export interface MemoryFile {
  /** Path relative to the memories root, always with "/" — e.g. "2D/erp.md". */
  relPath: string
  /** Folder chain that groups it, e.g. ["2D"]. Empty for a root memory. */
  folders: string[]
  title: string
  hook: string
}

export function memorySummary(markdown: string, filename: string): { title: string; hook: string } {
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() || filename.replace(/\.md$/i, '').replace(/-/g, ' ')
  const hook =
    /^description:\s*(.+)$/m.exec(markdown)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ||
    'Feedback aprendido com o usuário'
  return { title, hook }
}

/** Every memory file under `dir`, recursively, sorted by path. Never throws. */
export function listMemoryFiles(dir: string): MemoryFile[] {
  const out: MemoryFile[] = []
  const walk = (current: string, folders: string[]): void => {
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return // unreadable folder — skip it instead of killing the whole scan
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full, [...folders, entry.name])
        continue
      }
      if (!entry.name.endsWith('.md')) continue
      // The root index is the output of this scan, not an input to it.
      if (folders.length === 0 && entry.name === 'MEMORY.md') continue
      let markdown = ''
      try {
        markdown = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      const { title, hook } = memorySummary(markdown, entry.name)
      out.push({ relPath: [...folders, entry.name].join('/'), folders, title, hook })
    }
  }
  walk(dir, [])
  return out
}

/** One "- [Title](path) — hook" line, capped so the index stays scannable. */
export function memoryIndexLine(file: MemoryFile): string {
  const prefix = `- [${file.title}](${file.relPath}) — `
  return prefix + file.hook.slice(0, Math.max(20, 155 - prefix.length))
}

/**
 * Legacy compact index used by the curator/tests: the root index verbatim, then
 * a section per subfolder so the grouping the user created remains visible.
 */
export function renderMemoryIndex(dir: string, rootIndex: string): string {
  const grouped = new Map<string, MemoryFile[]>()
  for (const file of listMemoryFiles(dir)) {
    if (file.folders.length === 0) continue
    const key = file.folders.join('/')
    const bucket = grouped.get(key)
    if (bucket) bucket.push(file)
    else grouped.set(key, [file])
  }

  const sections: string[] = []
  for (const [folder, files] of grouped) {
    sections.push(
      `--- Pasta "${folder}" (memórias sobre ${folder}) ---\n${files.map(memoryIndexLine).join('\n')}`
    )
  }

  const root = `--- MEMORY.md (índice da raiz) ---\n${rootIndex || '(nenhuma memória salva na raiz)'}`
  if (sections.length === 0) return root
  return `${root}\n\n${sections.join('\n\n')}`
}

const MAX_SCANNED_MEMORIES = 250
const MAX_MEMORY_BYTES = 64 * 1024
const MAX_SELECTED_MEMORIES = 3
const MAX_EXCERPT_CHARS = 1_600
const MAX_TOTAL_EXCERPT_CHARS = 4_000
const STOP_WORDS = new Set(['a', 'ao', 'as', 'com', 'da', 'de', 'do', 'e', 'em', 'eu', 'me', 'na', 'no', 'o', 'os', 'para', 'por', 'que', 'um', 'uma'])

function normalizedTerms(text: string): string[] {
  return [...new Set(text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])]
    .filter((term) => !STOP_WORDS.has(term))
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function readRootIndex(dir: string): string {
  try {
    return readFileSync(join(dir, 'MEMORY.md'), 'utf8').trim()
  } catch {
    return ''
  }
}

export function buildMemoryIndexContext(dir: string): string {
  return renderMemoryIndex(dir, readRootIndex(dir))
}

/** Fresh optional index plus bounded excerpts relevant to this user turn. Never throws. */
export function buildDynamicMemoryContext(dir: string, query: string, includeIndex = true): string {
  const index = includeIndex ? buildMemoryIndexContext(dir) : ''
  const terms = normalizedTerms(query)
  if (terms.length === 0) return index

  let root: string
  try {
    root = realpathSync(dir)
  } catch {
    return index
  }

  const ranked: Array<{ file: MemoryFile; body: string; score: number }> = []
  for (const file of listMemoryFiles(dir).slice(0, MAX_SCANNED_MEMORIES)) {
    try {
      const full = realpathSync(join(root, ...file.relPath.split('/')))
      const size = statSync(full).size
      if (!pathInside(root, full) || size === 0 || size > MAX_MEMORY_BYTES) continue
      const body = readFileSync(full, 'utf8')
      if (body.includes('\0')) continue
      const metadata = normalizedTerms(`${file.folders.join(' ')} ${file.title} ${file.hook} ${file.relPath}`)
      const content = normalizedTerms(body)
      let score = 0
      for (const term of terms) {
        if (metadata.some((value) => value === term)) score += 6
        else if (metadata.some((value) => value.includes(term) || term.includes(value))) score += 3
        if (content.includes(term)) score += 1
      }
      if (score >= 3) ranked.push({ file, body, score })
    } catch {
      // A memory can disappear or become unreadable while a message is being sent.
    }
  }

  ranked.sort((a, b) => b.score - a.score || a.file.relPath.localeCompare(b.file.relPath))
  let remaining = MAX_TOTAL_EXCERPT_CHARS
  const excerpts: string[] = []
  for (const match of ranked.slice(0, MAX_SELECTED_MEMORIES)) {
    if (remaining <= 0) break
    const excerpt = match.body.trim().slice(0, Math.min(MAX_EXCERPT_CHARS, remaining))
    if (!excerpt) continue
    remaining -= excerpt.length
    excerpts.push(`--- Memória relevante: ${match.file.relPath} ---\n${excerpt}`)
  }
  if (excerpts.length === 0) return index
  return index ? `${index}\n\n${excerpts.join('\n\n')}` : excerpts.join('\n\n')
}
