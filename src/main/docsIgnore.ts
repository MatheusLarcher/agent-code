import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * O que a varredura da documentação NÃO visita.
 *
 * Existe porque o `docs/` deste projeto chegou a ter um ambiente Python inteiro
 * (`docs/spec/<plano>/_sandbox/laya-poc/.venv`, `.uv-cache`, `.uv-python`)
 * — ~54 mil caminhos que viravam ~2,4 MB de árvore no [PROJECT_DOCS_CONTEXT] a
 * cada chamada de ferramenta. Tudo aquilo já estava no `.gitignore`; a
 * varredura só não o lia.
 *
 * Duas camadas:
 * - pastas que nunca são documentação (dependências, build, cache, sandbox e
 *   qualquer pasta oculta), valendo mesmo sem `.gitignore`;
 * - o `.gitignore` da RAIZ do projeto, num subconjunto honesto da sintaxe:
 *   `*`, `?`, `**`, `/` inicial (ancorado), `/` final (só pasta) e comentários.
 *   Negação (`!padrão`) não reinclui nada — errar para o lado de omitir é o
 *   que protege o disco. `.gitignore` aninhados não são lidos.
 */
export interface DocsIgnore {
  /** `relPath` em formato posix, relativo à raiz do projeto (ex.: `docs/out`). */
  ignores(relPath: string, isDirectory: boolean): boolean
}

const ALWAYS_IGNORED_DIRS = new Set([
  'node_modules', 'out', 'dist', 'build', 'coverage', '_sandbox',
  '__pycache__', 'venv', 'site-packages', 'graphify-out'
])

/** Um `.gitignore` maior do que isto não é regra de projeto, é acidente. */
const MAX_GITIGNORE_BYTES = 256 * 1024

interface IgnoreRule {
  regex: RegExp
  dirOnly: boolean
  anchored: boolean
}

function globToRegexSource(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atSegmentStart = i === 0 || glob[i - 1] === '/'
        if (atSegmentStart && glob[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
        continue
      }
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return out
}

export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/\s+$/, '')
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.replace(/\/+$/, '')
    if (!line) continue
    const anchored = line.includes('/')
    line = line.replace(/^\/+/, '')
    if (!line) continue
    rules.push({ regex: new RegExp(`^${globToRegexSource(line)}$`), dirOnly, anchored })
  }
  return rules
}

export function createDocsIgnore(rules: IgnoreRule[]): DocsIgnore {
  return {
    ignores(relPath: string, isDirectory: boolean): boolean {
      const name = relPath.split('/').at(-1) ?? relPath
      if (isDirectory && (ALWAYS_IGNORED_DIRS.has(name) || name.startsWith('.'))) return true
      for (const rule of rules) {
        if (rule.dirOnly && !isDirectory) continue
        if (rule.regex.test(rule.anchored ? relPath : name)) return true
      }
      return false
    }
  }
}

/** Nunca lança: sem `.gitignore` legível, só as pastas fixas são puladas. */
export async function loadDocsIgnore(cwd: string): Promise<DocsIgnore> {
  const path = join(cwd, '.gitignore')
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_GITIGNORE_BYTES) return createDocsIgnore([])
    return createDocsIgnore(parseGitignore(await readFile(path, 'utf8')))
  } catch {
    return createDocsIgnore([])
  }
}
