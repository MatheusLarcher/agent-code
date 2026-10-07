import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { runGit, type GitRunner } from '../po/poGit'

/**
 * O git da fila do projeto: os arquivos sem commit da pasta (a pasta suja
 * segura o começo de um plano; a lista vai no 1º prompt do B quando o PO o
 * começa) e a foto antes × depois da avaliação do PO ("o PO alterou: …").
 *
 * Pasta que não é repositório, ou git que falha, devolve `null`: sem como
 * conferir, a fila não segura nada por causa do git.
 */

export interface ProjectGit {
  /** Os caminhos sem commit (`git status --porcelain -uall`); `null` sem git. */
  dirty(cwd: string): Promise<string[] | null>
  head(cwd: string): Promise<string | null>
  /** A foto dos arquivos sem commit, com mtime e tamanho (para ver o que o PO mexeu). */
  snapshot(cwd: string): Promise<Map<string, string> | null>
}

function unquote(path: string): string {
  if (!(path.startsWith('"') && path.endsWith('"'))) return path
  const body = path.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'))
      continue
    }
    const next = body[i + 1]
    if (/[0-7]/.test(next ?? '')) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8))
      i += 3
      continue
    }
    const map: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\' }
    bytes.push(...Buffer.from(map[next] ?? next ?? '', 'utf8'))
    i += 1
  }
  return Buffer.from(bytes).toString('utf8')
}

/** O caminho de uma linha do `--porcelain` (renomeado: o destino). */
export function porcelainPath(line: string): string {
  let path = line.slice(3)
  const arrow = path.indexOf(' -> ')
  if (arrow >= 0) path = path.slice(arrow + 4)
  return unquote(path.trim())
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0)
}

async function statusLines(cwd: string, run: GitRunner): Promise<string[] | null> {
  try {
    if ((await run(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') return null
    return lines(await run(cwd, ['status', '--porcelain', '-uall']))
  } catch {
    return null
  }
}

/** Os caminhos que mudaram entre duas fotos (novos, sumidos ou com mtime/tamanho diferente). */
export function changedBetween(before: Map<string, string>, after: Map<string, string>): string[] {
  const out = new Set<string>()
  for (const [path, sig] of after) if (before.get(path) !== sig) out.add(path)
  for (const path of before.keys()) if (!after.has(path)) out.add(path)
  return [...out].sort()
}

export function createProjectGit(run: GitRunner = runGit): ProjectGit {
  return {
    async dirty(cwd) {
      const status = await statusLines(cwd, run)
      return status ? status.map(porcelainPath) : null
    },
    async head(cwd) {
      try {
        return (await run(cwd, ['rev-parse', 'HEAD'])).trim() || null
      } catch {
        return null
      }
    },
    async snapshot(cwd) {
      const status = await statusLines(cwd, run)
      if (!status) return null
      const out = new Map<string, string>()
      for (const line of status) {
        const path = porcelainPath(line)
        const info = await stat(join(cwd, path)).catch(() => null)
        out.set(path, `${line.slice(0, 2)}|${info ? `${info.mtimeMs}|${info.size}` : 'sumiu'}`)
      }
      return out
    }
  }
}
