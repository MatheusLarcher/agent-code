import { z } from 'zod'
import { Channels, type OutboxEntryDto } from '../shared/ipc'
import type { ConversationOutboxRepository } from './persistence/types'
import type { OutboxWriteQueue } from './persistence/writeQueue/outboxQueue'

/**
 * A fila de espera das conversas (mensagens enviadas com o agente ocupado, do
 * usuário e do Agent Manager), gravada no banco para sobreviver a um reinício.
 * O renderer lê tudo no boot e entrega a fila de uma conversa a cada mudança — a
 * gravação é da fila do main (writeQueue/outboxQueue.ts): nova tentativa quando
 * o banco cai e diário local no fechamento, sem a tela esperar.
 *
 * Fronteira: zod em tudo. Única exceção que atravessa o IPC, de propósito: a
 * leitura com o banco fora (o renderer tenta de novo em vez de ver fila vazia).
 */

export type OutboxIpcListener = (event: unknown, ...args: unknown[]) => unknown

export interface OutboxIpcDeps {
  handle: (channel: string, listener: OutboxIpcListener) => void
  /** `null` quando o banco não aceita leitura/escrita agora. */
  repository: () => ConversationOutboxRepository | null
  queue: Pick<OutboxWriteQueue, 'replace' | 'overlay'>
}

/** Teto por fila: evita que um payload doente (anexos enormes) trave o banco. */
const MAX_ITEMS = 200
const MAX_PAYLOAD_CHARS = 50 * 1024 * 1024

const ReplaceReq = z.strictObject({
  conversationId: z.string().min(1).max(200),
  items: z
    .array(z.strictObject({ id: z.string().min(1).max(200), payload: z.unknown() }))
    .max(MAX_ITEMS)
})

export function registerOutboxIpc(deps: OutboxIpcDeps): void {
  deps.handle(Channels.outboxList, async (): Promise<OutboxEntryDto[]> => {
    // Banco fora: ERRO, nunca lista vazia. O renderer tomaria "vazia" por "sem
    // fila", e a próxima gravação de uma conversa apagaria a fila dela no banco.
    // Ele tenta de novo (useOutboxPersistence).
    const repo = deps.repository()
    if (!repo) throw new Error('fila gravada indisponível: banco fora')
    let stored: OutboxEntryDto[]
    try {
      stored = await repo.listConversationOutbox()
    } catch (error) {
      console.warn('[fila] não consegui ler a fila gravada:', (error as Error).message)
      throw new Error('fila gravada indisponível: leitura falhou')
    }
    // O que está na fila do main (ou voltou do diário) vale por cima do banco.
    return deps.queue.overlay(stored)
  })

  deps.handle(Channels.outboxReplace, async (_event, payload): Promise<{ ok: boolean }> => {
    const parsed = ReplaceReq.safeParse(payload)
    if (!parsed.success) return { ok: false }
    if (JSON.stringify(parsed.data.items).length > MAX_PAYLOAD_CHARS) return { ok: false }
    deps.queue.replace(parsed.data.conversationId, parsed.data.items)
    return { ok: true }
  })
}
