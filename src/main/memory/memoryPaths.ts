import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Plain path containment, before resolving links. */
export function pathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Containment after resolving symlinks/junctions, so a link planted inside the
 * folder cannot redirect a write outside it. For a path that does not exist yet
 * the parent directory is resolved instead. This is a check, not a lock: a
 * hostile process can still swap a link between this call and the write.
 */
export function realPathInside(root: string, candidate: string): boolean {
  if (!pathInside(root, candidate)) return false
  try {
    // Climb to the nearest ancestor that exists: a write may create several
    // levels at once (a new "2D/" subfolder), and stopping at the immediate
    // parent would report "outside" for a path that is plainly inside.
    let existing = resolve(candidate)
    while (!existsSync(existing)) {
      const parent = dirname(existing)
      if (parent === existing) return false
      existing = parent
    }
    return pathInside(realpathSync(root), realpathSync(existing))
  } catch {
    return false
  }
}

/** Tools whose whole purpose is to write a file. */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
/** Where each tool keeps its target path. */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'filePath'] as const

const GUIDANCE =
  'A pasta de memórias é gravada só pelo serviço de memória do Agent Code. ' +
  'Use a ferramenta memory_propose (op create/update/retire) em vez de escrever o arquivo. ' +
  'Ler a pasta continua liberado.'

function targetPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = []
  for (const field of PATH_FIELDS) {
    const value = input[field]
    if (typeof value === 'string' && value.trim()) paths.push(value)
  }
  const edits = input.edits
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const value = (edit as Record<string, unknown> | null)?.file_path
      if (typeof value === 'string' && value.trim()) paths.push(value)
    }
  }
  return paths
}

/**
 * Denial message when a tool call would write inside `memoriesDir`, or null when
 * it is unrelated. Deliberately consulted BEFORE "Permitir tudo": consistency of
 * the memory index must not depend on a permission toggle.
 *
 * LIMIT: for shell tools this can only inspect the command TEXT. A script, a
 * different MCP server or an obfuscated path still reaches the folder — this
 * closes the ordinary path, it is not a sandbox.
 */
export function memoryWriteDenial(
  memoriesDir: string,
  toolName: string,
  input: Record<string, unknown>
): string | null {
  if (FILE_WRITE_TOOLS.has(toolName)) {
    const hit = targetPaths(input).some((path) => realPathInside(memoriesDir, resolve(memoriesDir, path)))
    return hit ? `${toolName} bloqueado na pasta de memórias. ${GUIDANCE}` : null
  }
  if (toolName === 'Bash' || toolName === 'BashOutput') {
    const command = typeof input.command === 'string' ? input.command : ''
    if (!command) return null
    // Normalize both sides to forward slashes and lower case: a Windows path
    // arrives with either separator and is not case sensitive.
    const slash = (value: string): string => value.replace(/\\/g, '/').toLowerCase()
    if (!slash(command).includes(slash(resolve(memoriesDir)))) return null
    return `Comando bloqueado por citar a pasta de memórias. ${GUIDANCE}`
  }
  return null
}
