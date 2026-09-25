import { z } from 'zod'
import { Channels, type SuggestTitleResult } from '../../shared/ipc'
import { claudeObserverEnv } from '../observerQuery'
import { suggestConversationTitle, TITLE_INPUT_MAX_CHARS, TITLE_MODEL } from './conversationTitle'

/**
 * Handler de conversation:suggestTitle. O index.ts só chama
 * registerConversationTitleIpc com o ipcMain.handle dele.
 *
 * Fronteira: o payload passa por zod (texto string, cortado em
 * TITLE_INPUT_MAX_CHARS) e nenhuma exceção atravessa o IPC — sem título é
 * `{ ok: false }`, e o renderer fica com o recuo que já aplicou.
 */

export type TitleIpcListener = (event: unknown, ...args: unknown[]) => unknown

export interface ConversationTitleIpcDeps {
  /** Mesmo formato de ipcMain.handle. */
  handle: (channel: string, listener: TitleIpcListener) => void
  /** Para o teste; padrão: suggestConversationTitle (claude-haiku-4-5). */
  suggest?: (text: string, convId?: string) => Promise<string | null>
}

const SuggestTitleReq = z.strictObject({
  text: z.string().transform((s) => s.slice(0, TITLE_INPUT_MAX_CHARS)),
  /** Conversa do título: o pedido roda na mesma conta Claude dela. */
  convId: z.string().max(200).optional()
})

export function registerConversationTitleIpc(deps: ConversationTitleIpcDeps): void {
  const suggest =
    deps.suggest ??
    (async (text: string, convId?: string) =>
      suggestConversationTitle(text, { env: await claudeObserverEnv(convId, TITLE_MODEL) }))
  deps.handle(Channels.conversationSuggestTitle, async (_event, payload): Promise<SuggestTitleResult> => {
    const parsed = SuggestTitleReq.safeParse(payload)
    if (!parsed.success || !parsed.data.text.trim()) return { ok: false }
    try {
      const title = await suggest(parsed.data.text, parsed.data.convId)
      return typeof title === 'string' && title ? { ok: true, title } : { ok: false }
    } catch {
      return { ok: false }
    }
  })
}
