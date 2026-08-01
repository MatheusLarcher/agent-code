import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/**
 * Walks the memories folder — including SUBFOLDERS, which the user uses to group
 * memories by context (a `2D/` folder means "these are about 2D"). Both the
 * session hint and the curator's index reconciliation read the tree from here so
 * a memory filed under a folder is never invisible.
 */

/** Deep enough for "2D/clientes/x.md"; guards against a symlink loop. */
const MAX_DEPTH = 4

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
    if (folders.length > MAX_DEPTH) return
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return // unreadable folder — skip it instead of killing the whole scan
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
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
 * The memories block injected into every conversation: the root index verbatim,
 * then a section per subfolder so the model knows the grouping the user created.
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
