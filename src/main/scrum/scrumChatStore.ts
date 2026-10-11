import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { ScrumChatMessage } from '../../shared/scrumPanel'

/**
 * A CONVERSA COM O SCRUM MASTER, guardada inteira em `<userData>/scrum-chat.jsonl`:
 * uma linha por mensagem, só acréscimo, SEM limite e SEM rotação — é a
 * matéria-prima para melhorar o SM depois. As escritas entram em fila (duas
 * perguntas seguidas não se atropelam); a leitura pula linha quebrada e pagina
 * a partir do fim.
 */

export const SCRUM_CHAT_FILE = 'scrum-chat.jsonl'
export const SCRUM_CHAT_FILE_ENV = 'AGENT_CODE_SCRUM_CHAT_FILE'
export const SCRUM_CHAT_PAGE = 200

const Message = z.object({
  id: z.string(),
  at: z.string(),
  role: z.enum(['usuario', 'sm']),
  text: z.string(),
  sobre: z.string().nullable(),
  projectCwd: z.string().nullable()
})

export async function defaultScrumChatFile(): Promise<string | null> {
  const override = process.env[SCRUM_CHAT_FILE_ENV]
  if (override) return override
  if (!process.versions.electron) return null
  try {
    const { app } = await import('electron')
    return join(app.getPath('userData'), SCRUM_CHAT_FILE)
  } catch {
    return null
  }
}

/** As mensagens de um texto do arquivo, pulando linha quebrada ou de outro formato. */
export function parseScrumChat(text: string): ScrumChatMessage[] {
  const out: ScrumChatMessage[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const parsed = Message.safeParse(JSON.parse(line))
      if (parsed.success) out.push(parsed.data)
    } catch {
      // Gravação cortada no meio: segue para a próxima.
    }
  }
  return out
}

export class ScrumChatStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: () => Promise<string | null> = defaultScrumChatFile) {}

  /** Acrescenta no fim, depois de toda escrita anterior. Lança se o disco falhar. */
  append(...messages: ScrumChatMessage[]): Promise<void> {
    const lines = messages.map((m) => `${JSON.stringify(m)}\n`).join('')
    const next = this.queue
      .catch(() => undefined)
      .then(async () => {
        const target = await this.file()
        if (!target) throw new Error('não há onde guardar a conversa agora')
        await mkdir(dirname(target), { recursive: true })
        await appendFile(target, lines, 'utf8')
      })
    this.queue = next
    return next
  }

  /** A conversa inteira, na ordem. Arquivo ausente = vazia. Nunca lança. */
  async all(): Promise<ScrumChatMessage[]> {
    try {
      await this.queue.catch(() => undefined)
      const target = await this.file()
      if (!target) return []
      return parseScrumChat(await readFile(target, 'utf8'))
    } catch {
      return []
    }
  }

  /** Uma página a partir do fim: pula as `skip` últimas e devolve as `limit` antes delas. */
  async page(skip = 0, limit = SCRUM_CHAT_PAGE): Promise<{ messages: ScrumChatMessage[]; hasMore: boolean }> {
    const all = await this.all()
    const end = Math.max(0, all.length - Math.max(0, skip))
    const start = Math.max(0, end - Math.max(1, limit))
    return { messages: all.slice(start, end), hasMore: start > 0 }
  }
}
