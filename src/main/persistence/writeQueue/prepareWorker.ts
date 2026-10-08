/**
 * Worker da fila de gravação: limpa, normaliza, divide e calcula o hash do
 * documento da conversa fora do thread principal (um documento de 4 MB custava
 * ~22 ms de JSON e hash no main a cada gravação). Bundle próprio
 * (electron.vite.config.ts), irmão do index.js do main.
 */
import { parentPort } from 'node:worker_threads'
import type { ConversationRecord } from '../types'
import { prepareConversation, type ConversationHashScope } from './conversationPrepare'

interface Request {
  id: number
  doc: ConversationRecord
  scope: ConversationHashScope
  now: number
}

parentPort?.on('message', (request: Request) => {
  try {
    parentPort?.postMessage({ id: request.id, ok: true, prepared: prepareConversation(request.doc, request.scope, request.now) })
  } catch (error) {
    const typed = error as { code?: unknown; message?: unknown }
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      error: { code: typeof typed.code === 'string' ? typed.code : undefined, message: String(typed.message ?? error) }
    })
  }
})
