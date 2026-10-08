import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { StorageError, type ConversationRecord, type StorageErrorCode } from '../types'
import { prepareConversation, type ConversationHashScope, type PreparedConversation } from './conversationPrepare'

/** Quem prepara o documento antes de gravar: o worker no app, a própria função nos testes. */
export interface ConversationPreparer {
  prepare(doc: ConversationRecord, scope: ConversationHashScope): Promise<PreparedConversation>
  dispose(): void
}

export const inlinePreparer: ConversationPreparer = {
  prepare: async (doc, scope) => prepareConversation(doc, scope),
  dispose: () => undefined
}

const WORKER_FILE = 'conversationPrepareWorker.js'

/** O bundle do worker, irmão do index.js do main (ou um nível acima de um chunk). */
function workerPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  return [join(here, WORKER_FILE), join(here, '..', WORKER_FILE)].find((path) => existsSync(path)) ?? null
}

interface Pending {
  resolve: (prepared: PreparedConversation) => void
  reject: (error: Error) => void
}

/**
 * Um worker, pedidos numerados. Worker que morre recusa os pedidos em voo e é
 * recriado no próximo; sem o bundle do worker (testes, build sem ele), prepara no
 * próprio thread — devagar, mas correto.
 */
export function workerPreparer(): ConversationPreparer {
  const path = workerPath()
  if (!path) return inlinePreparer
  let worker: Worker | null = null
  let nextId = 1
  const pending = new Map<number, Pending>()

  const failAll = (error: Error): void => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }
  const spawn = (): Worker => {
    const created = new Worker(path)
    created.unref()
    created.on('message', (reply: { id: number; ok: boolean; prepared?: PreparedConversation; error?: { code?: string; message: string } }) => {
      const entry = pending.get(reply.id)
      if (!entry) return
      pending.delete(reply.id)
      if (reply.ok && reply.prepared) entry.resolve(reply.prepared)
      else {
        const code = (reply.error?.code ?? 'INVALID_PERSISTED_DATA') as StorageErrorCode
        entry.reject(new StorageError(code, reply.error?.message ?? 'A conversa não pôde ser preparada para gravar.'))
      }
    })
    const lost = (reason: string): void => {
      if (worker === created) worker = null
      failAll(new StorageError('STORAGE_OFFLINE', `O preparo da gravação parou (${reason}).`, true))
    }
    created.on('error', (error) => lost(error.message))
    created.on('exit', (code) => lost(`código ${code}`))
    return created
  }

  return {
    prepare(doc, scope) {
      worker ??= spawn()
      const id = nextId++
      return new Promise<PreparedConversation>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        worker!.postMessage({ id, doc, scope, now: Date.now() })
      })
    },
    dispose() {
      const current = worker
      worker = null
      failAll(new StorageError('STORAGE_OFFLINE', 'Preparo da gravação encerrado.', true))
      void current?.terminate()
    }
  }
}
