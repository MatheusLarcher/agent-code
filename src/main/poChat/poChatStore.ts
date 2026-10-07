/**
 * A conversa do "Fala, PO", guardada por projeto neste PC: um JSON por pasta
 * no userData (sobrevive a fechar e reiniciar, e não depende do banco). Fica
 * com as últimas PO_CHAT_KEEP_MESSAGES mensagens; o PO lê só as últimas trocas.
 * As escritas da mesma pasta entram em fila (duas perguntas seguidas não se
 * atropelam). Arquivo quebrado ou de formato errado: começa vazio.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { PO_CHAT_KEEP_MESSAGES, type PoChatMessage } from '../../shared/poChat'

const Message = z
  .object({
    id: z.string(),
    role: z.enum(['usuario', 'po']),
    text: z.string(),
    at: z.number(),
    sources: z.array(z.record(z.string(), z.unknown())).optional(),
    unconfirmed: z.string().nullable().optional(),
    options: z.array(z.record(z.string(), z.unknown())).optional(),
    verified: z.boolean().optional(),
    error: z.string().nullable().optional()
  })
  .passthrough()

const Thread = z.object({ projectKey: z.string(), messages: z.array(Message) })

export class PoChatStore {
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(private readonly dir: string) {}

  private file(projectKey: string): string {
    return join(this.dir, `${createHash('sha1').update(projectKey).digest('hex').slice(0, 20)}.json`)
  }

  async read(projectKey: string): Promise<PoChatMessage[]> {
    try {
      const parsed = Thread.safeParse(JSON.parse(await readFile(this.file(projectKey), 'utf8')))
      return parsed.success && parsed.data.projectKey === projectKey ? (parsed.data.messages as PoChatMessage[]) : []
    } catch {
      return []
    }
  }

  /** Acrescenta (ou troca, pelo id) e devolve a conversa inteira. */
  update(projectKey: string, change: (messages: PoChatMessage[]) => PoChatMessage[]): Promise<PoChatMessage[]> {
    const previous = this.chains.get(projectKey) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const messages = change(await this.read(projectKey)).slice(-PO_CHAT_KEEP_MESSAGES)
        await mkdir(this.dir, { recursive: true })
        const file = this.file(projectKey)
        const tmp = `${file}.${process.pid}.tmp`
        await writeFile(tmp, JSON.stringify({ projectKey, messages }), 'utf8')
        await rename(tmp, file)
        return messages
      })
    this.chains.set(projectKey, next)
    return next
  }

  append(projectKey: string, ...add: PoChatMessage[]): Promise<PoChatMessage[]> {
    return this.update(projectKey, (messages) => [...messages, ...add])
  }

  /** Troca a mensagem de mesmo id (a bolha "verificando…" vira a resposta verificada). */
  replace(projectKey: string, message: PoChatMessage): Promise<PoChatMessage[]> {
    return this.update(projectKey, (messages) => messages.map((m) => (m.id === message.id ? message : m)))
  }
}
