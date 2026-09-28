import { constants, type Stats } from 'node:fs'
import { open, realpath, readdir, lstat, stat, type FileHandle } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { loadDocsIgnore, type DocsIgnore } from './docsIgnore'
import { MAX_DOCS_CONTEXT_BYTES, ROOT_BUDGET_MARKER, renderOutlineBlock, type OutlineEntry } from './projectOutlineRender'

export { MAX_DOCS_CONTEXT_BYTES }

const MAX_MARKDOWN_BYTES = 64 * 1024
/** Orçamento de LEITURA dos Markdown da raiz = o teto do bloco. */
const MAX_ROOT_MARKDOWN_TOTAL_BYTES = MAX_DOCS_CONTEXT_BYTES
/** Teto de entradas visitadas por varredura: o bloco é cortado em 48 KiB de
 *  qualquer jeito, e visitar 50 mil arquivos a cada turno só custa I/O. */
const MAX_WALK_ENTRIES = 5000
/** Teto de títulos POR ARQUIVO no índice. Quando corta, o índice diz que cortou
 *  (ver `buildDocsIndex`) — exportado para o teste ler o mesmo número. */
export const MAX_HEADINGS = 32
const MAX_HEADING_LENGTH = 160
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd'])

/**
 * Quanto de cada arquivo a varredura captura.
 *
 * - `full` — o contexto de sempre: todo Markdown dentro de docs/ é aninhado e
 *   entra com as três primeiras linhas físicas (os da RAIZ do projeto, inteiros,
 *   vêm de `scanRootMarkdown`). É o que vai para o agente e para o memorista.
 * - `index` — só o MAPA: caminho de cada .md e os títulos das seções. Existe
 *   porque o `docs/` deste projeto passa de 85k tokens e o `state` do Jev aceita
 *   no máximo 32k: o gate precisa saber o que JÁ está documentado, não ler a
 *   documentação. Mesma varredura, mesma checagem de caminho — o que muda é o
 *   que se lê de dentro do arquivo.
 */
type OutlineMode = 'full' | 'index'

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

/**
 * Os títulos das seções de um Markdown, pela MESMA leitura verificada do
 * preview: realpath dentro do docs/, `O_NOFOLLOW`, e o arquivo tem que estar
 * estável entre o `stat` de antes e o de depois. Um índice não vale relaxar a
 * barreira de caminho que o resto do módulo mantém.
 */
async function readMarkdownHeadings(
  path: string,
  canonicalRoot: string
): Promise<{ headings: string[]; truncated: boolean; marker?: string }> {
  const { handle, before } = await openVerifiedRegularFile(path, canonicalRoot)
  try {
    const buffer = Buffer.alloc(Math.min(before.size, MAX_MARKDOWN_BYTES))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const after = await handle.stat()
    if (!stableFile(before, after)) return { headings: [], truncated: false, marker: '[changed during read]' }
    const text = buffer.subarray(0, bytesRead)
    if (text.includes(0)) return { headings: [], truncated: false, marker: '[binary markdown omitted]' }
    // Um título A MAIS do que cabe: é o único jeito de saber que houve corte sem
    // varrer o arquivo duas vezes. O extra é descartado, só o SINAL sobrevive.
    const found = extractMarkdownHeadings(text.toString('utf8'), MAX_HEADINGS + 1)
    return {
      headings: found.slice(0, MAX_HEADINGS),
      truncated: found.length > MAX_HEADINGS,
      ...(before.size > bytesRead ? { marker: '[first 64 KiB scanned]' } : {})
    }
  } finally {
    await handle.close()
  }
}

/** Estado de UMA varredura: orçamento de leitura da raiz, regras de ignorar e
 *  o teto de entradas visitadas. */
interface ScanState {
  remainingBytes: number
  ignore: DocsIgnore
  visited: number
  walkTruncated: boolean
}

function newScanState(ignore: DocsIgnore): ScanState {
  return { remainingBytes: MAX_ROOT_MARKDOWN_TOTAL_BYTES, ignore, visited: 0, walkTruncated: false }
}

async function readRootMarkdown(
  path: string,
  canonicalRoot: string,
  budget: ScanState
): Promise<{ content?: string; marker?: string }> {
  const { handle, before } = await openVerifiedRegularFile(path, canonicalRoot)
  try {
    if (before.size > budget.remainingBytes) return { marker: ROOT_BUDGET_MARKER }
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
  state: ScanState,
  mode: OutlineMode
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
    if (state.visited >= MAX_WALK_ENTRIES) {
      state.walkTruncated = true
      return
    }
    const absolutePath = join(absoluteDir, child.name)
    const path = relativePath(cwd, absolutePath)
    try {
      const stat = await lstat(absolutePath)
      // Dependências, build, sandbox e o que o .gitignore exclui não são
      // documentação: nem entram no bloco nem são percorridos.
      if (state.ignore.ignores(path, stat.isDirectory())) continue
      state.visited++
      if (stat.isSymbolicLink()) {
        entries.push({ path, depth, kind: 'symlink', marker: '[symlink]' })
      } else if (stat.isDirectory()) {
        entries.push({ path, depth, kind: 'directory' })
        await walk(cwd, absolutePath, canonicalRoot, depth + 1, entries, state, mode)
      } else {
        const entry: OutlineEntry = { path, depth, kind: 'file', marker: fileMarker(path) }
        if (MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase())) {
          try {
            if (mode === 'index') {
              const result = await readMarkdownHeadings(absolutePath, canonicalRoot)
              entry.headings = result.headings
              if (result.truncated) entry.headingsTruncated = true
              if (result.marker) entry.marker = result.marker
            } else {
              // Tudo dentro de docs/ é ANINHADO em relação à raiz do projeto:
              // caminho + três primeiras linhas, nunca o arquivo inteiro. (A
              // regra antiga, `depth === 1`, mandava docs/*.md inteiros.)
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

/** A varredura do docs/, ou o motivo de não haver nenhuma. Uma função só para
 *  os dois modos: a checagem da raiz é a mesma, e duplicá-la é como uma das
 *  cópias deixa de recusar um symlink. */
async function scanDocs(
  cwd: string,
  mode: OutlineMode,
  state: ScanState
): Promise<{ entries: OutlineEntry[] } | { unavailable: string }> {
  const docsDir = join(cwd, 'docs')
  let canonicalRoot: string

  try {
    const stat = await lstat(docsDir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { unavailable: '[not a directory]' }
    canonicalRoot = await realpath(docsDir)
  } catch (err) {
    return { unavailable: safeReason(err) === 'ENOENT' ? '[not present]' : `[unavailable: ${safeReason(err)}]` }
  }

  const entries: OutlineEntry[] = [{ path: 'docs', depth: 0, kind: 'directory' }]
  await walk(cwd, docsDir, canonicalRoot, 1, entries, state, mode)
  return { entries }
}

/**
 * Os Markdown da RAIZ do projeto (não recursivo): os únicos que entram
 * completos. Mesma leitura verificada do resto do módulo; o que o `.gitignore`
 * exclui fica de fora, e um arquivo que não cabe no orçamento de 48 KiB vira
 * marcador + três primeiras linhas.
 */
async function scanRootMarkdown(cwd: string, state: ScanState): Promise<OutlineEntry[]> {
  let canonicalRoot: string
  let children
  try {
    canonicalRoot = await realpath(cwd)
    children = await readdir(cwd, { withFileTypes: true })
  } catch {
    return []
  }
  const entries: OutlineEntry[] = []
  children.sort((a, b) => a.name.localeCompare(b.name, 'en'))
  for (const child of children) {
    if (!MARKDOWN_EXTENSIONS.has(extname(child.name).toLowerCase())) continue
    const absolutePath = join(cwd, child.name)
    const path = relativePath(cwd, absolutePath)
    try {
      const info = await lstat(absolutePath)
      if (info.isDirectory() || state.ignore.ignores(path, false)) continue
      if (info.isSymbolicLink()) {
        entries.push({ path, depth: 0, kind: 'symlink', marker: '[symlink]' })
        continue
      }
      const entry: OutlineEntry = { path, depth: 0, kind: 'file' }
      try {
        const result = await readRootMarkdown(absolutePath, canonicalRoot, state)
        entry.content = result.content
        if (result.marker) entry.marker = result.marker
        if (result.marker === ROOT_BUDGET_MARKER) {
          entry.preview = (await readMarkdownPreview(absolutePath, canonicalRoot)).preview
        }
      } catch (err) {
        entry.marker = `[unreadable: ${safeReason(err)}]`
      }
      entries.push(entry)
    } catch (err) {
      entries.push({ path, depth: 0, kind: 'file', marker: `[unreadable: ${safeReason(err)}]` })
    }
  }
  return entries
}

export async function buildProjectOutline(cwd: string): Promise<string> {
  const state = newScanState(await loadDocsIgnore(cwd))
  const rootEntries = await scanRootMarkdown(cwd, state)
  const scan = await scanDocs(cwd, 'full', state)
  const docsEntries: OutlineEntry[] = 'unavailable' in scan
    ? [{ path: 'docs', depth: 0, kind: 'directory', marker: scan.unavailable }]
    : scan.entries
  const notes = state.walkTruncated ? [`... varredura de docs/ interrompida após ${MAX_WALK_ENTRIES} entradas`] : []
  return renderOutlineBlock([...rootEntries, ...docsEntries], notes)
}

/**
 * Orçamento global de títulos do índice.
 *
 * O teto por arquivo (`MAX_HEADINGS`) não limita nada quando a pasta tem
 * centenas de .md — e o índice existe justamente para caber num `state` de 32k
 * tokens. Passando daqui, o índice continua listando os CAMINHOS (que é o mapa)
 * e para de listar seções.
 */
const MAX_INDEX_HEADINGS = 600

/**
 * O MAPA do docs/: cada arquivo pelo caminho, cada Markdown pelos títulos das
 * seções. Nunca o conteúdo.
 *
 * É o que o gate `noul` recebe para responder "isso já está documentado?" sem
 * carregar os ~85k tokens do docs/ inteiro num `state` que aceita 32k. Nunca
 * lança: pasta ausente ou ilegível vira um marcador, não uma exceção.
 */
export async function buildDocsIndex(cwd: string): Promise<string> {
  const scan = await scanDocs(cwd, 'index', newScanState(await loadDocsIgnore(cwd)))
  if ('unavailable' in scan) return `[PROJECT_DOCS_INDEX]\ndocs/ ${scan.unavailable}\n[/PROJECT_DOCS_INDEX]`

  const lines = [
    '[PROJECT_DOCS_INDEX]',
    'Índice da documentação do projeto: o caminho de cada arquivo e os títulos das seções. É o mapa, não o conteúdo.'
  ]
  let budget = MAX_INDEX_HEADINGS
  for (const entry of scan.entries) {
    const suffix = entry.kind === 'directory' ? '/' : ''
    const marker = entry.marker ? ` ${entry.marker}` : ''
    lines.push(`${'  '.repeat(entry.depth)}${entry.path.split('/').at(-1)}${suffix}${marker}`)
    let listed = 0
    for (const heading of entry.headings ?? []) {
      if (budget <= 0) break
      budget--
      listed++
      lines.push(`${'  '.repeat(entry.depth + 1)}${heading}`)
    }
    // O corte por arquivo tem de aparecer, como o global já aparecia: sem isto o
    // gate lê o índice como se fosse a lista COMPLETA de seções do arquivo.
    // Só quando o que sumiu foi por causa deste teto — se o orçamento global
    // estourou antes, a linha de fechamento abaixo já explica o que houve.
    if (entry.headingsTruncated && listed === (entry.headings?.length ?? 0)) {
      lines.push(`${'  '.repeat(entry.depth + 1)}(seções além das ${MAX_HEADINGS} primeiras omitidas)`)
    }
  }
  if (budget <= 0) lines.push(`(títulos além de ${MAX_INDEX_HEADINGS} omitidos; os caminhos estão todos aqui)`)
  lines.push('[/PROJECT_DOCS_INDEX]')
  return lines.join('\n')
}
