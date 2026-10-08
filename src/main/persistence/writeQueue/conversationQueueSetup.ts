import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Channels, type ConversationSaveStatusDto } from '../../../shared/ipc'
import type { LeaseRenewal } from '../conversationWriteRecovery'
import { resolveProjectIdentity, type ProjectIdentity } from '../projectIdentity'
import type { LeaseFence, PersistenceRepository, VersionedConversation } from '../types'
import { parseConversationChanges } from './conversationChange'
import { ConversationJournal } from './conversationJournal'
import { ConversationWriteQueue } from './conversationWriteQueue'
import { workerPreparer } from './preparer'

/** A identidade do projeto por pasta, guardada por 10 min: antes, cada gravação de
 *  conversa rodava dois processos `git` (remote get-url e rev-list). */
export function cachedProjectIdentity(ttlMs = 10 * 60_000): (cwd: string) => Promise<ProjectIdentity> {
  const cache = new Map<string, { at: number; identity: Promise<ProjectIdentity> }>()
  return (cwd) => {
    const key = resolve(cwd).toLowerCase()
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ttlMs) return hit.identity
    const identity = resolveProjectIdentity(cwd)
    cache.set(key, { at: Date.now(), identity })
    // Pasta que não existe (ou git que falhou) não fica guardada.
    identity.catch(() => {
      if (cache.get(key)?.identity === identity) cache.delete(key)
    })
    return identity
  }
}

export interface ConversationQueueSetup {
  send(channel: string, payload: unknown): void
  repository(): PersistenceRepository | null
  installationId(): string | null
  lease(id: string): { fence: LeaseFence; renew?: LeaseRenewal } | undefined
  /** Pasta do diário (`%LOCALAPPDATA%\agent-code\fila`). */
  journalDir: string
  /** Log da fila: falhas e, a cada minuto com atividade, os números. */
  logFile: string
}

/** Prazo que a tela pode pedir num flush: entre 0 e 60 s. */
function deadlineOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(60_000, Math.max(0, value)) : 2_000
}

function idsOf(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : null
}

export function createConversationWriteQueue(deps: ConversationQueueSetup): ConversationWriteQueue {
  const log = (line: string): void => {
    void mkdir(dirname(deps.logFile), { recursive: true })
      .then(() => appendFile(deps.logFile, `[${new Date().toISOString()}] ${line}\n`))
      .catch(() => undefined)
  }
  let last: ConversationSaveStatusDto['state'] = 'saved'
  const queue = new ConversationWriteQueue({
    repository: deps.repository,
    preparer: workerPreparer(),
    journal: new ConversationJournal(deps.journalDir),
    lease: deps.lease,
    identity: cachedProjectIdentity(),
    installationId: deps.installationId,
    onStatus: (status) => {
      if (status.state !== last) log(`estado ${last} -> ${status.state} (pendentes=${status.pending}, mais antiga=${status.oldestMs} ms)`)
      last = status.state
      deps.send(Channels.conversationsSaveStatus, status)
    },
    onResync: (id) => deps.send(Channels.conversationsResync, id),
    onCentralRemote: (record: VersionedConversation) => deps.send(Channels.conversationsCentralRemote, record),
    log
  })
  // A cada minuto com atividade: o que dá para medir ("item mais antigo < 2 s").
  setInterval(() => {
    const stats = queue.takeStats()
    if (stats.written || stats.unchanged || stats.failed) {
      log(`gravadas=${stats.written} sem-mudança=${stats.unchanged} falhas=${stats.failed} maior-espera=${stats.maxWaitMs} ms`)
    }
  }, 60_000).unref()
  return queue
}

export function registerConversationQueueIpc(
  ipcMain: {
    on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown
  },
  queue: ConversationWriteQueue
): void {
  // `send` da tela: entrega e segue, sem resposta.
  ipcMain.on(Channels.conversationsSync, (_event, raw) => queue.apply(parseConversationChanges(raw)))
  ipcMain.handle(Channels.conversationsFlush, (_event, ids, deadlineMs) => queue.flush(idsOf(ids), deadlineOf(deadlineMs)))
  ipcMain.handle(Channels.conversationsSaveStatus, () => queue.status())
}
