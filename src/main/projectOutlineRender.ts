/**
 * Montagem do bloco [PROJECT_DOCS_CONTEXT] a partir da varredura feita em
 * `projectOutline.ts`, sob um teto DURO de bytes.
 */

/**
 * Teto DURO do bloco [PROJECT_DOCS_CONTEXT] inteiro, em bytes UTF-8.
 *
 * O bloco vai como `additionalContext` de hook, e o Claude Code grava em disco
 * toda saída de hook grande (`tool-results/hook-*-additionalContext.txt`). Sem
 * teto ele chegou a 2,8 MB por chamada — 6,6 GB numa conversa. 48 KiB (~12k
 * tokens) cabem os Markdown da raiz de um projeto comum mais a árvore e as três
 * primeiras linhas de uma centena de documentos; o que passar é cortado com o
 * aviso de quantos arquivos ficaram de fora. Também é o orçamento de LEITURA
 * dos Markdown da raiz: não se lê do disco o que nunca caberia no bloco.
 */
export const MAX_DOCS_CONTEXT_BYTES = 48 * 1024
/** Espaço guardado no fim do bloco para as linhas de corte e o fechamento. */
const RENDER_RESERVE_BYTES = 512

export const ROOT_BUDGET_MARKER = `[full content omitted: ${MAX_DOCS_CONTEXT_BYTES / 1024} KiB docs context cap]`

export interface OutlineEntry {
  path: string
  depth: number
  kind: 'directory' | 'file' | 'symlink'
  /** The first three physical lines of nested Markdown, never parsed headings. */
  preview?: string[]
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
  const lines = [`${'  '.repeat(entry.depth)}${entry.path.split('/').at(-1)}${suffix}${marker}`]
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
  return lines
}

/** Formas cada vez menores de uma entrada, para caber no que resta do teto:
 *  completa → três primeiras linhas → só o caminho. */
function renderCandidates(entry: OutlineEntry): string[][] {
  const candidates = [renderEntry(entry)]
  if (entry.content !== undefined) {
    const preview = entry.content.split(/\r\n|\r|\n/).slice(0, 3)
    candidates.push(renderEntry({ ...entry, content: undefined, preview, marker: ROOT_BUDGET_MARKER }))
  }
  if (entry.content !== undefined || entry.preview !== undefined) {
    const marker = entry.content !== undefined
      ? ROOT_BUDGET_MARKER
      : `${entry.marker ? `${entry.marker} ` : ''}[preview omitted: docs context cap]`
    candidates.push(renderEntry({ ...entry, content: undefined, preview: undefined, marker }))
  }
  return candidates
}

const byteLength = (lines: string[]): number => Buffer.byteLength(lines.join('\n'), 'utf8') + 1

/**
 * O bloco inteiro, nunca acima de `MAX_DOCS_CONTEXT_BYTES`. Cada entrada entra
 * na maior forma que ainda cabe; quando nem o caminho cabe, o resto é contado e
 * anunciado numa linha só.
 */
export function renderOutlineBlock(entries: OutlineEntry[], notes: string[] = []): string {
  const lines = [
    '[PROJECT_DOCS_CONTEXT]',
    'Fresh authoritative project documentation at request time. Root Markdown files (project root) are complete; ' +
      'Markdown under docs/ includes its path and first three physical lines only. Paths ignored by .gitignore, ' +
      `dependency/build/sandbox folders and hidden folders are skipped. The whole block is capped at ${MAX_DOCS_CONTEXT_BYTES / 1024} KiB.`
  ]
  const limit = MAX_DOCS_CONTEXT_BYTES - RENDER_RESERVE_BYTES
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
    lines.push(`... ${omittedFiles} arquivos omitidos (e ${omittedDirs} pastas): teto de ${MAX_DOCS_CONTEXT_BYTES / 1024} KiB do bloco`)
  }
  lines.push(...notes)
  lines.push('[/PROJECT_DOCS_CONTEXT]')
  return lines.join('\n')
}
