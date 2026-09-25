import { z } from 'zod'
import { Channels, type OutboxEntryDto } from '../shared/ipc'
import type { ConversationOutboxRepository } from './persistence/types'

/**
 * A fila de espera das conversas (mensagens enviadas com o agente ocupado, do
 * usuário e do Agent Manager), gravada no banco para sobreviver a um reinício.
 * O renderer lê tudo no boot e regrava a fila de uma conversa a cada mudança.
 *
 * Fronteira: zod em tudo, nenhuma exceção atravessa o IPC. Banco indisponível
 * (somente leitura, migrando) = lista vazia / `ok: false`.
 */

export type OutboxIpcListener = (event: unknown, ...args: unknown[]) => unknown

export interface OutboxIpcDeps {
  handle: (channel: string, listener: OutboxIpcListener) => void
  /** `null` quando o banco não aceita escrita agora. */
  repository: () => ConversationOutboxRepository | null
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
    try {
      const repo = deps.repository()
      return repo ? await repo.listConversationOutbox() : []
    } catch (error) {
      console.warn('[fila] não consegui ler a fila gravada:', (error as Error).message)
      return []
    }
  })

  deps.handle(Channels.outboxReplace, async (_event, payload): Promise<{ ok: boolean }> => {
    const parsed = ReplaceReq.safeParse(payload)
    if (!parsed.success) return { ok: false }
    if (JSON.stringify(parsed.data.items).length > MAX_PAYLOAD_CHARS) return { ok: false }
    try {
      const repo = deps.repository()
      if (!repo) return { ok: false }
      await repo.replaceConversationOutbox(parsed.data.conversationId, parsed.data.items)
      return { ok: true }
    } catch (error) {
      console.warn('[fila] não consegui gravar a fila:', (error as Error).message)
      return { ok: false }
    }
  })
}
