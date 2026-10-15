import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import {
  memoryFileIndex,
  memoryFileIndexVersion,
  memoryFileTerms,
  memorySummary,
  normalizedTerms,
  watchedMemoryFileIndex,
  type CachedMemoryFile,
  type MemoryFileIndex
} from './memory/memoryFileCache'

export { memorySummary }

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

/** Content signature checked before every user dispatch. It hashes the bodies:
 * cloud sync can preserve both size and timestamp while replacing a memory, and
 * that change must still invalidate the authoritative catalog. The bodies come
 * from the in-memory index (memory/memoryFileCache.ts), which keeps them current
 * — all Markdown files, root index included; symlinks and hidden entries skipped. */
export function memoryCatalogFilesystemVersion(dir: string): string {
  return memoryFileIndexVersion(memoryFileIndex(dir))
}

export function renderMemoryCatalog(files: MemoryCatalogFile[], rootDir = ''): string {
  // Only the root index is injected into every conversation. Individual memory
  // files remain available on disk and the model is explicitly given the root
  // folder so it can read one on demand when the task requires it.
  const entries = files
    .filter((file) => file.relPath.toLowerCase() === 'memory.md')
    .map(
    (file) => `--- MEMORY FILE: ${file.relPath} ---\n${file.content.trim() || '(empty memory file)'}`
    )
  return redactMemorySecrets(`[AUTHORITATIVE PERSISTENT MEMORY CATALOG]
This is the complete MEMORY.md index for this user at conversation startup. The other memory files are
not injected automatically; read them from the configured memories directory when they are relevant.
The configured memories directory is:
${rootDir || '(not specified)'}
Use the Read tool with this directory and the relative path listed in MEMORY.md to load a complete memory.
A later [PERSISTENT_MEMORY_UPDATE] replaces this entire index; do not combine stale entries with the replacement.

${entries.length > 0 ? entries.join('\n\n') : '(no persistent memory files are currently available)'}
[/AUTHORITATIVE PERSISTENT MEMORY CATALOG]`)
}

/** Every Markdown memory (from the in-memory index) when a conversation starts or the version changed. */
export function createMemoryCatalogSnapshot(dir: string): MemoryCatalogSnapshot {
  const index = memoryFileIndex(dir)
  const files: MemoryCatalogFile[] = index.files
    .filter((file) => !file.hasNul)
    .map((file) => ({ relPath: file.relPath, content: file.content, modifiedAtMs: file.mtimeMs, sizeBytes: file.sizeBytes }))
  const catalog = renderMemoryCatalog(files, dir)
  const filesystemVersion = memoryFileIndexVersion(index)
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

const memoryFileLists = new WeakMap<MemoryFileIndex, MemoryFile[]>()

/** A lista de `listMemoryFiles` de uma geração do índice, montada uma vez por geração. */
function memoryFilesOf(index: MemoryFileIndex): MemoryFile[] {
  let list = memoryFileLists.get(index)
  if (!list) {
    list = index.files
      // `.md` minúsculo, como a varredura direta sempre exigiu aqui; o índice da
      // raiz é a saída desta lista, não uma entrada dela.
      .filter((file) => file.name.endsWith('.md') && !(file.folders.length === 0 && file.name === 'MEMORY.md'))
      .map((file) => ({ relPath: file.relPath, folders: file.folders, title: file.title, hook: file.hook }))
    memoryFileLists.set(index, list)
  }
  return list
}

/** Every memory file under `dir`, recursively, sorted by path. Never throws.
 * Served from the in-memory index (memory/memoryFileCache.ts). */
export function listMemoryFiles(dir: string): MemoryFile[] {
  return memoryFilesOf(memoryFileIndex(dir)).slice()
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
/** Guarda de tamanho: uma memória acima disso é PULADA, nunca cortada ao meio.
 * Injetar meio arquivo é pior que não injetar — o modelo age no que faltou. */
const MAX_MEMORY_BYTES = 64 * 1024
/** Teto de memórias por turno na busca lexical e no TypeSafe. O Haiku tem o
 *  dele (HAIKU_MEMORY_MAX, em memorySelectionHaiku.ts). */
export const MAX_SELECTED_MEMORIES = 10
/** Teto de uma memória sozinha: acima disso ela é pulada, nunca cortada. */
const MAX_EXCERPT_CHARS = 50_000
/** Teto do bloco inteiro do turno, em caracteres. Memória que estoura o que
 * sobra é PULADA (a próxima, menor, ainda pode caber), nunca cortada. */
export const MAX_TOTAL_EXCERPT_CHARS = 50_000

/** Memory values belong in the encrypted vault, never in automatic context.
 * Old/manual notes can still contain common credential assignments, so protect
 * the automatic excerpt path even though normal memory_propose writes only a
 * {{secret:name}} reference. */
export function redactMemorySecrets(text: string): string {
  return text
    .replace(/\{\{secret:[^}]+\}\}/giu, '[secret reference withheld]')
    .replace(
      /^(\s*(?:api[_ -]?key|access[_ -]?token|auth(?:orization)?|client[_ -]?secret|password|passwd|secret)\s*[:=]\s*)(\S.*)$/gimu,
      '$1[redacted]'
    )
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function readRootIndex(dir: string): string {
  const cached = watchedMemoryFileIndex(dir)?.byRelPath.get('MEMORY.md')
  if (cached) return cached.content.trim()
  try {
    return readFileSync(join(dir, 'MEMORY.md'), 'utf8').trim()
  } catch {
    return ''
  }
}

/** O arquivo vale como memória injetável: não vazio, sem NUL e dentro do teto. */
function injectable(file: CachedMemoryFile): boolean {
  return !file.hasNul && file.bytes > 0 && file.bytes <= MAX_MEMORY_BYTES
}

/** Leitura direta do disco, para caminho que o índice não conhece (fora do
 * padrão, link, maiúsculas trocadas no Windows). Mesmas guardas de sempre: o
 * caminho resolvido fica dentro da raiz; vazio, grande demais ou binário é `null`. */
function readMemoryFileFromDisk(dir: string, relPath: string): string | null {
  try {
    const root = realpathSync(dir)
    const full = realpathSync(join(root, ...relPath.split('/')))
    if (!pathInside(root, full)) return null
    const size = statSync(full).size
    if (size === 0 || size > MAX_MEMORY_BYTES) return null
    const body = readFileSync(full, 'utf8')
    return body.includes('\0') ? null : body
  } catch {
    return null
  }
}

export function buildMemoryIndexContext(dir: string): string {
  return renderMemoryIndex(dir, readRootIndex(dir))
}

export interface RankedMemory {
  file: MemoryFile
  /** Body read while scoring. Do not inject it: it can be stale by request time. */
  body: string
  score: number
}

/** Pontuação mínima para um trecho lexical valer a pena no prompt. */
export const MIN_LEXICAL_SCORE = 3

/**
 * Score every candidate memory against this user turn, best first. The only
 * relevance ranker in the app — the TypeSafe selector reuses it as its
 * pre-filter when there are more candidates than `choice` accepts. Never throws.
 *
 * `candidates` defaults to the first `MAX_SCANNED_MEMORIES` files on disk; pass
 * an explicit list to rank a different (or complete) set.
 */
export function rankMemoriesByQuery(dir: string, query: string, candidates?: MemoryFile[]): RankedMemory[] {
  const terms = normalizedTerms(query)
  if (terms.length === 0) return []

  // Corpo e termos vêm do índice em memória; o disco só é tocado para um
  // candidato que o índice não conhece.
  const index = memoryFileIndex(dir)
  if (!index.rootExists) return []

  const ranked: RankedMemory[] = []
  for (const file of candidates ?? memoryFilesOf(index).slice(0, MAX_SCANNED_MEMORIES)) {
    const cached = index.byRelPath.get(file.relPath)
    let body: string | null
    let metadata: string[] | null = null
    let content: { has(term: string): boolean }
    if (cached) {
      if (!injectable(cached)) continue
      body = cached.content
      const cachedTerms = memoryFileTerms(cached)
      // O cabeçalho do candidato é o do índice (o comum): reaproveita os termos.
      if (file.title === cached.title && file.hook === cached.hook && file.folders.join('/') === cached.folders.join('/')) {
        metadata = cachedTerms.meta
      }
      content = cachedTerms.content
    } else {
      body = readMemoryFileFromDisk(dir, file.relPath)
      if (body === null) continue
      content = new Set(normalizedTerms(body))
    }
    metadata ??= normalizedTerms(`${file.folders.join(' ')} ${file.title} ${file.hook} ${file.relPath}`)
    let score = 0
    for (const term of terms) {
      if (metadata.some((value) => value === term)) score += 6
      else if (metadata.some((value) => value.includes(term) || term.includes(value))) score += 3
      if (content.has(term)) score += 1
    }
    ranked.push({ file, body, score })
  }

  ranked.sort((a, b) => b.score - a.score || a.file.relPath.localeCompare(b.file.relPath))
  return ranked
}

/**
 * The COMPLETE current text of one memory, re-read from disk and redacted.
 *
 * `relPath` is treated as untrusted (it can come back from a remote decision):
 * the resolved path must stay inside the memories root. `null` when it escapes,
 * is unreadable, empty, binary or larger than `MAX_MEMORY_BYTES` — a memory is
 * skipped whole, never truncated.
 */
export function readMemoryBody(dir: string, relPath: string): string | null {
  // Árvore grande: o índice mantido pelo vigia é o atual. Árvore pequena (ou sem
  // índice ainda): um arquivo lido direto custa menos que revarrer a pasta.
  const cached = watchedMemoryFileIndex(dir)?.byRelPath.get(relPath)
  const body = cached ? (injectable(cached) ? cached.content : null) : readMemoryFileFromDisk(dir, relPath)
  if (body === null) return null
  const redacted = redactMemorySecrets(body).trim()
  return redacted || null
}

/** O cabeçalho de uma memória injetada. Um só formato, os dois seletores. */
export function memoryContextBlock(relPath: string, text: string): string {
  return `--- Memória relevante: ${relPath} ---\n${text}`
}

/** Uma memória escolhida para o turno: o caminho e o texto já redigido. */
export interface MemoryEntry {
  relPath: string
  body: string
}

/** A escolha de memórias de um turno: o bloco, os caminhos e o texto de cada uma. */
export interface ChosenMemories {
  block: string
  relPaths: string[]
  entries: MemoryEntry[]
}

/**
 * Junta memórias em blocos até `maxCount` memórias e `maxChars` caracteres no
 * total (cabeçalhos e separadores inclusos). Cada `relPath` é relido do disco
 * (`readMemoryBody` redige e recusa o que escapa da pasta); a que não cabe no
 * que sobra é PULADA inteira e a seguinte ainda é tentada. Nunca lança.
 */
export function assembleMemories(dir: string, relPaths: readonly string[], maxCount = MAX_SELECTED_MEMORIES, maxChars = MAX_TOTAL_EXCERPT_CHARS): ChosenMemories {
  const entries: MemoryEntry[] = []
  const blocks: string[] = []
  const seen = new Set<string>()
  let used = 0
  for (const relPath of relPaths) {
    if (entries.length >= maxCount) break
    if (seen.has(relPath)) continue
    seen.add(relPath)
    const body = readMemoryBody(dir, relPath)
    if (!body || body.length > MAX_EXCERPT_CHARS) continue
    const block = memoryContextBlock(relPath, body)
    const cost = block.length + (blocks.length > 0 ? 2 : 0)
    if (used + cost > maxChars) continue
    used += cost
    blocks.push(block)
    entries.push({ relPath, body })
  }
  return { block: blocks.join('\n\n'), relPaths: entries.map((entry) => entry.relPath), entries }
}

/** As memórias do turno pela busca lexical: até 10, até 50.000 caracteres, inteiras. Nunca lança. */
export function selectMemoriesLexically(dir: string, query: string): ChosenMemories {
  const ranked = rankMemoriesByQuery(dir, query).filter((match) => match.score >= MIN_LEXICAL_SCORE)
  return assembleMemories(dir, ranked.map((match) => match.file.relPath))
}

/** Fresh optional index plus bounded relevant memories for this user turn. Never throws. */
export function buildDynamicMemoryContext(dir: string, query: string, includeIndex = true): string {
  const index = includeIndex ? buildMemoryIndexContext(dir) : ''
  const { block } = selectMemoriesLexically(dir, query)
  if (!block) return index
  return index ? `${index}\n\n${block}` : block
}
