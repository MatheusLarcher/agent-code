/**
 * Listing of ONE project folder at a time, for the "Todos os arquivos" tree of
 * the office code screen (loaded on demand as the user expands folders).
 *
 * Input comes from the renderer, so it is validated here: `root` must be an
 * absolute, existing directory; `rel` must be a relative path that stays inside
 * it (no absolute path, no `..` segment). Generated/huge folders
 * (MENTION_IGNORE) are skipped. Never throws: failures come back in `error`.
 */
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ProjectDirEntry, ProjectDirListing } from '../shared/ipc'

/** Directories never worth walking (noise / huge / generated) — "@" menu, project map and file tree. */
export const MENTION_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.gradle', '.vite',
  'coverage', '.next', '.turbo', '.cache', '.idea'
])

/** Entries returned per folder at most. */
export const PROJECT_DIR_MAX = 500

const fail = (error: string): ProjectDirListing => ({ entries: [], truncated: false, error })

/** The relative folder in forward-slash form, or null when it is absolute or tries to leave the root. */
export function safeRelDir(rel: unknown): string | null {
  if (typeof rel !== 'string') return null
  const s = rel.replace(/\\/g, '/').trim()
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s) || isAbsolute(rel)) return null
  const parts = s.split('/').filter((p) => p && p !== '.')
  if (parts.some((p) => p === '..' || p.includes('\0'))) return null
  return parts.join('/')
}

export async function listProjectDir(root: unknown, rel: unknown): Promise<ProjectDirListing> {
  if (typeof root !== 'string' || !root || !isAbsolute(root)) return fail('Pasta do projeto inválida.')
  const dir = safeRelDir(rel)
  if (dir === null) return fail('Caminho fora da pasta do projeto.')
  const base = resolve(root)
  const abs = resolve(base, dir)
  const back = relative(base, abs)
  // Defense in depth: safeRelDir already refuses `..`, this catches anything resolve() would still escape with.
  if (back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) return fail('Caminho fora da pasta do projeto.')
  try {
    if (!(await stat(base)).isDirectory()) return fail('A pasta do projeto não existe.')
  } catch {
    return fail('A pasta do projeto não existe.')
  }
  let found: import('node:fs').Dirent[]
  try {
    found = await readdir(abs, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return fail(code === 'ENOENT' ? 'A pasta não existe mais.' : code === 'ENOTDIR' ? 'Não é uma pasta.' : 'Não deu para ler a pasta.')
  }
  const entries: ProjectDirEntry[] = found
    .filter((e) => !(e.isDirectory() && MENTION_IGNORE.has(e.name)))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((e) => ({ path: dir ? `${dir}/${e.name}` : e.name, name: e.name, isDir: e.isDirectory() }))
  return { entries: entries.slice(0, PROJECT_DIR_MAX), truncated: entries.length > PROJECT_DIR_MAX, error: null }
}
