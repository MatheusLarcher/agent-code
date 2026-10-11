/**
 * Montagem do bloco [PROJECT_DOCS_CONTEXT] a partir da varredura feita em
 * `projectOutline.ts`, sob um teto DURO de bytes.
 */

/**
 * Teto do `additionalContext` de hook no Claude Code: 10.000 CARACTERES por
 * campo, sem configuração para subir (https://code.claude.com/docs/en/hooks).
 * Acima disso o CLI grava a saída em disco e o modelo recebe só o caminho e
 * uma prévia de 2.000 caracteres ("Output too large") — medido também numa
 * sessão real: 15,3 KB já chegavam cortados.
 */
export const HOOK_CONTEXT_MAX_CHARS = 10_000

/**
 * Teto PADRÃO do bloco [PROJECT_DOCS_CONTEXT] inteiro, em bytes UTF-8 (bytes ≥
 * caracteres, então o teto em bytes garante o de caracteres).
 *
 * O bloco vai no `additionalContext` do hook junto com a memória do turno, e o
 * conjunto tem de caber em `HOOK_CONTEXT_MAX_CHARS` — quem monta o hook passa
 * o orçamento que sobra (`docsBudgetFor`). 9 KiB cabem AGENTS.md e CLAUDE.md
 * da raiz inteiros mais o ÍNDICE (caminho — primeiro título) de README e docs/;
 * o que passar é cortado com o aviso de quantos arquivos ficaram de fora.
 */
export const MAX_DOCS_CONTEXT_BYTES = 9 * 1024
/** Abaixo disto o bloco não leva nem as regras do projeto: é o piso do orçamento. */
export const MIN_DOCS_CONTEXT_BYTES = 2 * 1024
/** Folga para o separador entre docs e memória e o arredondamento. */
const HOOK_SEPARATOR_RESERVE = 200
/** Espaço guardado no fim do bloco para as linhas de corte e o fechamento. */
const RENDER_RESERVE_BYTES = 512

export const ROOT_BUDGET_MARKER = '[full content omitted: docs context cap]'

/**
 * O orçamento do bloco de docs quando ele divide o hook com `memory`: o que
 * sobra dos 10.000 caracteres, entre o piso e o teto padrão. Memória enorme
 * (a escolha do TypeSafe pode trazer memórias inteiras) não zera as regras do
 * projeto — o piso fica, e o hook passa do teto: aí é a memória que estourou.
 */
export function docsBudgetFor(memory: string): number {
  const left = HOOK_CONTEXT_MAX_CHARS - HOOK_SEPARATOR_RESERVE - memory.length
  return Math.max(MIN_DOCS_CONTEXT_BYTES, Math.min(MAX_DOCS_CONTEXT_BYTES, left))
}

const kib = (bytes: number): string => `${Math.round((bytes / 1024) * 10) / 10} KiB`

export interface OutlineEntry {
  path: string
  depth: number
  kind: 'directory' | 'file' | 'symlink'
  /** O primeiro título do Markdown (sem os `#`): o índice. */
  title?: string
  content?: string
  /** Só no modo `index`: os títulos das seções, na ordem em que aparecem. */
  headings?: string[]
  /** O arquivo tem MAIS seções do que `MAX_HEADINGS`. Sem este sinal, um índice
   *  cortado é indistinguível de um arquivo curto, e o gate conclui "isso não
   *  está documentado" sobre uma seção que existe e ficou de fora. */
  headingsTruncated?: boolean
  marker?: string
}

function renderEntry(entry: OutlineEntry): string[] {
  const suffix = entry.kind === 'directory' ? '/' : ''
  const marker = entry.marker ? ` ${entry.marker}` : ''
  const title = entry.title ? ` — ${entry.title}` : ''
  const lines = [`${'  '.repeat(entry.depth)}${entry.path.split('/').at(-1)}${suffix}${marker}${title}`]
  if (entry.content !== undefined) {
    lines.push(`--- PROJECT DOC FILE: ${entry.path} ---`)
    lines.push(entry.content || '(empty markdown file)')
    lines.push(`--- END PROJECT DOC FILE: ${entry.path} ---`)
  }
  return lines
}

/** O primeiro título de um texto Markdown (ATX `# x`), sem os `#`; senão a primeira linha não vazia. */
export function firstTitle(text: string): string | undefined {
  const lines = text.split(/\r\n|\r|\n/)
  const heading = lines.find((line) => /^\s{0,3}#{1,6}\s+\S/.test(line))
  const raw = heading ? heading.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '') : lines.find((line) => line.trim())
  const clean = raw?.replace(/\s+/g, ' ').trim().slice(0, 120)
  return clean || undefined
}

/** Formas cada vez menores de uma entrada, para caber no que resta do teto:
 *  completa → caminho + título → só o caminho. */
function renderCandidates(entry: OutlineEntry): string[][] {
  const candidates = [renderEntry(entry)]
  if (entry.content !== undefined) {
    candidates.push(renderEntry({ ...entry, content: undefined, title: entry.title ?? firstTitle(entry.content), marker: ROOT_BUDGET_MARKER }))
  }
  if (entry.content !== undefined || entry.title !== undefined) {
    const marker = entry.content !== undefined ? ROOT_BUDGET_MARKER : entry.marker
    candidates.push(renderEntry({ ...entry, content: undefined, title: undefined, ...(marker ? { marker } : {}) }))
  }
  return candidates
}

const byteLength = (lines: string[]): number => Buffer.byteLength(lines.join('\n'), 'utf8') + 1

/**
 * O bloco inteiro, nunca acima de `maxBytes` (padrão `MAX_DOCS_CONTEXT_BYTES`).
 * Cada entrada entra na maior forma que ainda cabe; quando nem o caminho cabe,
 * o resto é contado e anunciado numa linha só.
 */
export function renderOutlineBlock(entries: OutlineEntry[], notes: string[] = [], maxBytes: number = MAX_DOCS_CONTEXT_BYTES): string {
  const lines = [
    '[PROJECT_DOCS_CONTEXT]',
    'Fresh authoritative project documentation at request time. Root AGENTS.md and CLAUDE.md are complete; README.md, ' +
      'other root Markdown and Markdown under docs/ are an INDEX (path — first title): open one with Read when the task needs it. ' +
      'Paths ignored by .gitignore, dependency/build/sandbox folders and hidden folders are skipped. ' +
      `The whole block is capped at ${kib(maxBytes)}.`
  ]
  const limit = maxBytes - RENDER_RESERVE_BYTES
  let used = byteLength(lines)
  let omittedFiles = 0
  let omittedDirs = 0
  for (const entry of entries) {
    const fitting = omittedFiles + omittedDirs === 0
      ? renderCandidates(entry).find((candidate) => used + byteLength(candidate) <= limit)
      : undefined
    if (!fitting) {
      // Parou de caber: daqui em diante nada entra (a árvore cortada no meio
      // com buracos seria pior do que cortada num ponto só, e anunciada).
      if (entry.kind === 'directory') omittedDirs++
      else omittedFiles++
      continue
    }
    lines.push(...fitting)
    used += byteLength(fitting)
  }
  if (omittedFiles + omittedDirs > 0) {
    lines.push(`... ${omittedFiles} arquivos omitidos (e ${omittedDirs} pastas): teto de ${kib(maxBytes)} do bloco`)
  }
  lines.push(...notes)
  lines.push('[/PROJECT_DOCS_CONTEXT]')
  return lines.join('\n')
}
