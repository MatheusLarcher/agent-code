import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, watch, type Dirent, type FSWatcher, type Stats } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Índice em memória da pasta de memórias: caminho, título, gancho, corpo,
 * termos normalizados e mtime/ctime/tamanho de cada `.md`. Existe para tirar o
 * I/O síncrono do envio — com ~700 memórias, varrer, ler e pontuar a pasta a
 * cada mensagem custava centenas de ms no processo main.
 *
 * Como fica atual:
 * - Árvore PEQUENA (até `SMALL_TREE_MAX_FILES` arquivos): cada consulta revarre
 *   e relê a pasta síncrona. Custa poucos ms e mantém a consistência imediata
 *   (gravar e consultar em seguida enxerga a mudança, mesmo com o mesmo tamanho
 *   e timestamp).
 * - Árvore GRANDE: a consulta devolve o índice pronto, sem tocar no disco. Um
 *   `fs.watch` recursivo marca a mudança e dispara uma revalidação ASSÍNCRONA
 *   (fs.promises, em lotes que cedem o loop); uma consulta com mais de
 *   `REVALIDATE_AFTER_MS` desde a última revalidação também a dispara, para
 *   cobrir evento perdido. Criar, editar ou apagar aparece em até ~2 s.
 *
 * A PRIMEIRA consulta de uma pasta sem índice pronto lê a árvore síncrona UMA
 * vez (é o que devolve uma resposta correta já). Quem quiser evitar até essa
 * leitura chama `warmMemoryFileCache(dir)` antes, na partida.
 */

/** Acima disso a árvore deixa de ser revarrida a cada consulta e passa ao vigia. */
export const SMALL_TREE_MAX_FILES = 128
/** Consulta com o índice mais velho que isso dispara revalidação em segundo plano. */
export const REVALIDATE_AFTER_MS = 2_000
/** Junta a rajada de eventos de um salvamento numa revalidação só. */
const WATCH_DEBOUNCE_MS = 100
/** Arquivos por lote na revalidação assíncrona; entre lotes o loop é cedido. */
const ASYNC_BATCH = 24
/** Pastas com índice vivo ao mesmo tempo; a mais antiga sai (e fecha o vigia). */
const MAX_CACHED_DIRS = 8

const STOP_WORDS = new Set(['a', 'ao', 'as', 'com', 'da', 'de', 'do', 'e', 'em', 'eu', 'me', 'na', 'no', 'o', 'os', 'para', 'por', 'que', 'um', 'uma'])

export function normalizedTerms(text: string): string[] {
  return [...new Set(text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])]
    .filter((term) => !STOP_WORDS.has(term))
}

export function memorySummary(markdown: string, filename: string): { title: string; hook: string } {
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() || filename.replace(/\.md$/i, '').replace(/-/g, ' ')
  const hook =
    /^description:\s*(.+)$/m.exec(markdown)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ||
    'Feedback aprendido com o usuário'
  return { title, hook }
}

/** Um `.md` da árvore, lido. Imutável: mudança no disco gera outro objeto. */
export interface CachedMemoryFile {
  /** Relativo à raiz, sempre com "/". */
  relPath: string
  name: string
  folders: string[]
  fullPath: string
  mtimeMs: number
  ctimeMs: number
  /** Tamanho do stat. */
  sizeBytes: number
  /** Bytes efetivamente lidos — é o que as guardas de tamanho conferem. */
  bytes: number
  content: string
  hasNul: boolean
  title: string
  hook: string
}

export interface MemoryFileTerms {
  /** Termos de pastas + título + gancho + caminho. */
  meta: string[]
  content: Set<string>
}

/** Uma geração do índice. Imutável: enquanto nada muda, é o MESMO objeto. */
export interface MemoryFileIndex {
  dir: string
  rootExists: boolean
  /** Na ordem da varredura (localeCompare por nível), como a leitura direta fazia. */
  files: readonly CachedMemoryFile[]
  byRelPath: ReadonlyMap<string, CachedMemoryFile>
  /** true quando a árvore é grande e o índice é mantido pelo vigia. */
  watched: boolean
}

const termsCache = new WeakMap<CachedMemoryFile, MemoryFileTerms>()
const versionCache = new WeakMap<MemoryFileIndex, string>()

/** Termos do arquivo, calculados uma vez por versão do arquivo. */
export function memoryFileTerms(file: CachedMemoryFile): MemoryFileTerms {
  let terms = termsCache.get(file)
  if (!terms) {
    terms = {
      meta: normalizedTerms(`${file.folders.join(' ')} ${file.title} ${file.hook} ${file.relPath}`),
      content: new Set(normalizedTerms(file.content))
    }
    termsCache.set(file, terms)
  }
  return terms
}

/** Assinatura por conteúdo da geração (pasta + caminho + corpo de cada arquivo
 * sem NUL). Calculada uma vez por geração. */
export function memoryFileIndexVersion(index: MemoryFileIndex): string {
  let version = versionCache.get(index)
  if (version === undefined) {
    const hash = createHash('sha256').update(index.dir).update('\0')
    for (const file of index.files) {
      if (file.hasNul) continue
      hash.update(file.relPath).update('\0').update(file.content, 'utf8').update('\0')
    }
    version = hash.digest('hex')
    versionCache.set(index, version)
  }
  return version
}

interface FoundFile {
  relPath: string
  name: string
  folders: string[]
  fullPath: string
}

function acceptEntries(entries: Dirent<string>[]): Dirent<string>[] {
  return entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((entry) => !entry.name.startsWith('.') && !entry.isSymbolicLink())
}

function isMemoryFile(entry: Dirent<string>): boolean {
  return entry.isFile() && entry.name.toLowerCase().endsWith('.md')
}

function makeFile(found: FoundFile, stats: Stats, buffer: Buffer): CachedMemoryFile {
  const content = buffer.toString('utf8')
  const { title, hook } = memorySummary(content, found.name)
  return {
    ...found,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    sizeBytes: stats.size,
    bytes: buffer.length,
    content,
    hasNul: content.includes('\0'),
    title,
    hook
  }
}

function sameStats(file: CachedMemoryFile | undefined, found: FoundFile, stats: Stats): file is CachedMemoryFile {
  return !!file && file.fullPath === found.fullPath && file.mtimeMs === stats.mtimeMs && file.ctimeMs === stats.ctimeMs && file.sizeBytes === stats.size
}

function buildIndex(dir: string, rootExists: boolean, files: CachedMemoryFile[], watched: boolean, prev: MemoryFileIndex | null): MemoryFileIndex {
  if (
    prev && prev.rootExists === rootExists && prev.watched === watched && prev.files.length === files.length &&
    files.every((file, i) => file === prev.files[i])
  ) {
    return prev
  }
  return { dir, rootExists, files, byRelPath: new Map(files.map((file) => [file.relPath, file])), watched }
}

/** Varredura síncrona completa: stat e corpo de cada arquivo. Reaproveita o
 * objeto anterior quando corpo, mtime e tamanho não mudaram. */
function scanSync(dir: string, prev: MemoryFileIndex | null): { rootExists: boolean; files: CachedMemoryFile[] } {
  const found: FoundFile[] = []
  let rootExists = true
  const walk = (current: string, folders: string[]): void => {
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      if (folders.length === 0) rootExists = false
      return
    }
    for (const entry of acceptEntries(entries)) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) walk(fullPath, [...folders, entry.name])
      else if (isMemoryFile(entry)) found.push({ relPath: [...folders, entry.name].join('/'), name: entry.name, folders, fullPath })
    }
  }
  walk(dir, [])
  const files: CachedMemoryFile[] = []
  for (const item of found) {
    try {
      const stats = statSync(item.fullPath)
      const buffer = readFileSync(item.fullPath)
      const old = prev?.byRelPath.get(item.relPath)
      const fresh = makeFile(item, stats, buffer)
      files.push(
        old && old.fullPath === fresh.fullPath && old.content === fresh.content && old.mtimeMs === fresh.mtimeMs && old.sizeBytes === fresh.sizeBytes
          ? old
          : fresh
      )
    } catch {
      // Um arquivo pode sumir ou ficar ilegível durante a varredura.
    }
  }
  return { rootExists, files }
}

const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Varredura assíncrona: só relê o que mudou de stat ou o que o vigia citou. */
async function scanAsync(dir: string, prev: MemoryFileIndex | null, forced: ReadonlySet<string>): Promise<{ rootExists: boolean; files: CachedMemoryFile[] }> {
  const found: FoundFile[] = []
  let rootExists = true
  const walk = async (current: string, folders: string[]): Promise<void> => {
    let entries: Dirent<string>[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      if (folders.length === 0) rootExists = false
      return
    }
    for (const entry of acceptEntries(entries)) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) await walk(fullPath, [...folders, entry.name])
      else if (isMemoryFile(entry)) found.push({ relPath: [...folders, entry.name].join('/'), name: entry.name, folders, fullPath })
    }
    await yieldLoop()
  }
  await walk(dir, [])
  const files: Array<CachedMemoryFile | null> = []
  for (let start = 0; start < found.length; start += ASYNC_BATCH) {
    const batch = await Promise.all(found.slice(start, start + ASYNC_BATCH).map(async (item) => {
      try {
        const stats = await stat(item.fullPath)
        const old = prev?.byRelPath.get(item.relPath)
        if (!forced.has(item.relPath) && sameStats(old, item, stats)) return old
        const fresh = makeFile(item, stats, await readFile(item.fullPath))
        // Mesmo corpo relido (o vigia citou, mas nada mudou): mantém o objeto.
        if (old && old.content === fresh.content && old.mtimeMs === fresh.mtimeMs && old.sizeBytes === fresh.sizeBytes && old.fullPath === fresh.fullPath) return old
        if (!fresh.hasNul) memoryFileTerms(fresh)
        return fresh
      } catch {
        return null
      }
    }))
    files.push(...batch)
    await yieldLoop()
  }
  return { rootExists, files: files.filter((file): file is CachedMemoryFile => file !== null) }
}

class DirCache {
  index: MemoryFileIndex | null = null
  private watcher: FSWatcher | null = null
  private forced = new Set<string>()
  private running: Promise<void> | null = null
  private rerun = false
  private timer: NodeJS.Timeout | null = null
  private lastValidatedAt = 0
  /** Ordem das varreduras: uma assíncrona velha nunca sobrescreve uma mais nova. */
  private scanSeq = 0
  private appliedSeq = 0
  private disposed = false

  constructor(readonly dir: string) {}

  /** Índice para uma consulta síncrona (ver o comentário do módulo). */
  current(): MemoryFileIndex {
    if (!this.index || !this.index.watched) {
      const seq = ++this.scanSeq
      const { rootExists, files } = scanSync(this.dir, this.index)
      this.apply(seq, rootExists, files, Date.now())
    } else if (Date.now() - this.lastValidatedAt > REVALIDATE_AFTER_MS) {
      this.schedule(0)
    }
    return this.index!
  }

  /** Revalida em segundo plano, cedendo o loop entre lotes. */
  revalidate(): Promise<void> {
    if (this.running) {
      this.rerun = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.rerun = false
        const forced = this.forced
        this.forced = new Set()
        const seq = ++this.scanSeq
        const startedAt = Date.now()
        const { rootExists, files } = await scanAsync(this.dir, this.index, forced)
        this.apply(seq, rootExists, files, startedAt)
        // A assinatura também sai do envio: calcula já, fora do caminho crítico.
        await yieldLoop()
        if (this.index) memoryFileIndexVersion(this.index)
      } while (this.rerun && !this.disposed)
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  dispose(): void {
    this.disposed = true
    this.closeWatcher()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private apply(seq: number, rootExists: boolean, files: CachedMemoryFile[], validatedAt: number): void {
    if (seq < this.appliedSeq || this.disposed) return
    this.appliedSeq = seq
    this.lastValidatedAt = validatedAt
    const watched = files.length > SMALL_TREE_MAX_FILES
    this.index = buildIndex(this.dir, rootExists, files, watched, this.index)
    if (watched) this.openWatcher()
    else this.closeWatcher()
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.disposed) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.revalidate().catch(() => undefined)
    }, delayMs)
    this.timer.unref?.()
  }

  private openWatcher(): void {
    if (this.watcher) return
    try {
      // persistent: false — o vigia não segura o processo vivo.
      this.watcher = watch(this.dir, { recursive: true, persistent: false }, (_event, filename) => {
        // O arquivo citado é relido mesmo com stat igual (troca com mesmo tamanho e mtime).
        if (typeof filename === 'string' && filename) this.forced.add(filename.split(/[\\/]/).join('/'))
        if (this.running) this.rerun = true
        this.schedule(WATCH_DEBOUNCE_MS)
      })
      this.watcher.on('error', () => {
        // Pasta removida ou vigia perdido: segue pela revalidação por idade.
        this.closeWatcher()
      })
    } catch {
      this.watcher = null
    }
  }

  private closeWatcher(): void {
    try {
      this.watcher?.close()
    } catch {
      // já fechado
    }
    this.watcher = null
  }
}

const caches = new Map<string, DirCache>()

function cacheFor(dir: string): DirCache {
  let cache = caches.get(dir)
  if (cache) {
    caches.delete(dir)
  } else {
    cache = new DirCache(dir)
  }
  caches.set(dir, cache)
  while (caches.size > MAX_CACHED_DIRS) {
    const [oldest, evicted] = caches.entries().next().value as [string, DirCache]
    evicted.dispose()
    caches.delete(oldest)
  }
  return cache
}

/** Índice atual de `dir` para uma consulta síncrona. Nunca lança. */
export function memoryFileIndex(dir: string): MemoryFileIndex {
  return cacheFor(dir).current()
}

/** O índice de `dir` só se ele é mantido pelo vigia (árvore grande). `null` em
 * árvore pequena ou sem índice: aí ler o arquivo direto é o caminho barato. */
export function watchedMemoryFileIndex(dir: string): MemoryFileIndex | null {
  const cache = caches.get(dir)
  if (!cache?.index?.watched) return null
  return cache.current()
}

/** Aquece (ou revalida) o índice de `dir` sem bloquear o loop. */
export async function warmMemoryFileCache(dir: string): Promise<MemoryFileIndex> {
  const cache = cacheFor(dir)
  await cache.revalidate()
  return cache.index!
}

/** Fecha o vigia e esquece o índice de `dir` (ou de todas as pastas). */
export function disposeMemoryFileCache(dir?: string): void {
  for (const [key, cache] of [...caches]) {
    if (dir !== undefined && key !== dir) continue
    cache.dispose()
    caches.delete(key)
  }
}
