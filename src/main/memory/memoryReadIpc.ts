/**
 * O painel de Memórias do Escritório lê por aqui — SÓ LEITURA, sobre o
 * memoryService: a lista (sem o corpo) e o texto de uma memória. Entrada
 * validada na fronteira; serviço fora do ar vira lista vazia / null (o painel
 * é uma janela de observação, não um diálogo de erro).
 */
import { Channels } from '../../shared/ipc'
import type { MemoryListItem, MemoryReadResult } from '../../shared/memoryPanel'
import type { MemoryEntry } from '../persistence/types'

interface Deps {
  handle(channel: string, handler: (_event: unknown, ...args: unknown[]) => unknown): void
  /** As memórias (ativas e aposentadas); null com o serviço fora do ar. */
  entries(): Promise<MemoryEntry[]> | null
}

const folderOf = (relPath: string): string => {
  const i = relPath.lastIndexOf('/')
  return i < 0 ? '' : relPath.slice(0, i)
}

export function toListItem(e: MemoryEntry): MemoryListItem {
  return { relPath: e.relPath, title: e.title, hook: e.hook, folder: folderOf(e.relPath), scope: e.scope, projectCwd: e.projectCwd, revision: e.revision, status: e.status, updatedAt: e.updatedAt }
}

const validRel = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !v.includes('\0')

export function registerMemoryReadIpc(deps: Deps): void {
  deps.handle(Channels.memoryListEntries, async (): Promise<MemoryListItem[]> => {
    try {
      return (await (deps.entries() ?? Promise.resolve([]))).map(toListItem)
    } catch {
      return []
    }
  })
  deps.handle(Channels.memoryReadEntry, async (_e, relPath): Promise<MemoryReadResult | null> => {
    if (!validRel(relPath)) return null
    try {
      const all = await (deps.entries() ?? Promise.resolve([]))
      // O chat tira o caminho do arquivo no disco: no Windows a caixa pode não bater.
      const lower = relPath.toLowerCase()
      const loose = all.filter((x) => x.relPath.toLowerCase() === lower)
      const e = all.find((x) => x.relPath === relPath) ?? (loose.length === 1 ? loose[0] : undefined)
      return e ? { relPath: e.relPath, title: e.title, hook: e.hook, body: e.body } : null
    } catch {
      return null
    }
  })
}
