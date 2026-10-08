import { downloadablesFromMessages } from '../downloadAllowlist'
import type { RemoteConversation, RemoteConversationLight, RemoteStatePayload } from '../../shared/ipc'
import { searchUserPrompts, type RemoteSearchResult } from '../../shared/remoteSearch'

/**
 * O que a ponte do celular sabe das conversas. A tela publica só o estado LEVE
 * (ocupado, conectado, permissão, plano, tokens…), e só das conversas que mudaram;
 * as mensagens vêm daqui quando o celular pede: do instantâneo da fila de gravação
 * (o mais novo, já no main) ou do banco, para a conversa que não passou pela fila.
 */

export interface RemoteMessageSource {
  /** O instantâneo da fila de gravação (síncrono); null se a conversa não passou por ela. */
  snapshot(convId: string): readonly unknown[] | null
  /** Do banco, quando a fila não tem a conversa; null se ela não está lá. Rejeita sem banco. */
  load(convId: string): Promise<readonly unknown[] | null>
}

/** O celular não espera o banco: sem resposta nisto, o histórico volta "indisponível" (503) e ele tenta de novo depois. */
export const LOAD_DEADLINE_MS = 3_000

export type RemoteQuestion = NonNullable<RemoteConversation['questions']>[number]
export type RemoteConversationSummary = Omit<RemoteConversation, 'messages'> & { messageCount: number }
type Globals = Omit<RemoteStatePayload, 'conversations' | 'delta' | 'removed'>

/** Conversas lidas do banco para o celular ficam guardadas: poucas (o celular abre uma por vez). */
const LOADED_LIMIT = 8

function userQuestions(messages: readonly unknown[]): RemoteQuestion[] {
  const out: RemoteQuestion[] = []
  messages.forEach((m, position) => {
    const msg = m as { kind?: string; id?: string; text?: string; ts?: number } | null
    if (msg && msg.kind === 'user' && typeof msg.id === 'string') {
      out.push({ id: msg.id, text: typeof msg.text === 'string' ? msg.text : '', ...(typeof msg.ts === 'number' ? { ts: msg.ts } : {}), position })
    }
  })
  return out
}

export class RemoteConversationStore {
  private readonly byId = new Map<string, RemoteConversationLight>()
  private globals: Globals = {}
  private readonly loaded = new Map<string, readonly unknown[]>()
  /** As perguntas de cada lista de mensagens: recalculadas só quando a lista muda. */
  private readonly questions = new WeakMap<readonly unknown[], RemoteQuestion[]>()

  constructor(private readonly source?: RemoteMessageSource) {}

  /** Sem `delta`, a lista inteira é trocada; com `delta`, só as que mudaram (e as que saíram). */
  apply(payload: RemoteStatePayload): void {
    if (!payload.delta) this.byId.clear()
    for (const conversation of payload.conversations ?? []) {
      this.byId.set(conversation.id, conversation)
      // A conversa mudou: o que foi lido do banco antes pode estar velho.
      if (!conversation.messages) this.loaded.delete(conversation.id)
    }
    for (const id of payload.removed ?? []) {
      this.byId.delete(id)
      this.loaded.delete(id)
    }
    const { conversations: _c, delta: _d, removed: _r, ...globals } = payload
    this.globals = { ...this.globals, ...globals }
  }

  list(): RemoteConversationLight[] {
    return [...this.byId.values()]
  }

  get(id: string): RemoteConversationLight | undefined {
    return this.byId.get(id)
  }

  global<K extends keyof Globals>(key: K): Globals[K] {
    return this.globals[key]
  }

  setGlobal<K extends keyof Globals>(key: K, value: Globals[K]): void {
    this.globals = { ...this.globals, [key]: value }
  }

  /** Atualização otimista de uma resposta do próprio celular (modo rápido, modelo…). */
  patch(id: string, fields: Partial<RemoteConversationLight>): void {
    const current = this.byId.get(id)
    if (current) this.byId.set(id, { ...current, ...fields })
  }

  /** O que já está em memória: o instantâneo da fila, o publicado (cliente antigo) ou o lido do banco. */
  messagesNow(id: string): readonly unknown[] | null {
    const fromQueue = this.source?.snapshot(id)
    if (fromQueue) return fromQueue
    const published = this.byId.get(id)?.messages
    if (published) return published
    const cached = this.loaded.get(id)
    if (cached) {
      // Mais recente no fim: a mais antiga sai primeiro quando passa do limite.
      this.loaded.delete(id)
      this.loaded.set(id, cached)
    }
    return cached ?? null
  }

  /** As mensagens de uma conversa para o celular (histórico): em memória ou do banco.
   *  null = o banco não respondeu (fora do ar, ou mais que LOAD_DEADLINE_MS). */
  async messages(id: string): Promise<readonly unknown[] | null> {
    const now = this.messagesNow(id)
    if (now) return now
    if (!this.source || !this.byId.has(id)) return []
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), LOAD_DEADLINE_MS)))
    const fromDb = await Promise.race([this.source.load(id), deadline])
      .catch(() => undefined)
      .finally(() => clearTimeout(timer))
    if (fromDb === undefined) return null
    if (!fromDb) return []
    this.loaded.set(id, fromDb)
    while (this.loaded.size > LOADED_LIMIT) this.loaded.delete(this.loaded.keys().next().value as string)
    return fromDb
  }

  /** O `/api/state`: o resumo de cada conversa, com as perguntas quando as mensagens estão à mão. */
  summaries(): RemoteConversationSummary[] {
    return this.list().map((conversation) => {
      const { messages: _messages, messageCount, ...rest } = conversation
      const messages = this.messagesNow(conversation.id)
      const queued = conversation.queued ?? []
      const count = messages?.length ?? messageCount ?? 0
      const queuedQuestions: RemoteQuestion[] = queued
        .filter((item) => typeof item.id === 'string')
        .map((item, index) => ({ id: item.id as string, text: item.text, position: count + index, queued: true }))
      let questions: RemoteQuestion[] | undefined
      if (messages) {
        let own = this.questions.get(messages)
        if (!own) {
          own = userQuestions(messages)
          this.questions.set(messages, own)
        }
        questions = queuedQuestions.length ? [...own, ...queuedQuestions] : own
      } else if (queuedQuestions.length) {
        questions = queuedQuestions
      }
      return { ...rest, queued, messageCount: count, ...(questions ? { questions } : {}) }
    })
  }

  /** Arquivos que o celular pode baixar, das mensagens que estão em memória. */
  downloadables(): string[] {
    const out: string[] = []
    for (const conversation of this.byId.values()) {
      const messages = this.messagesNow(conversation.id)
      if (messages) out.push(...downloadablesFromMessages(messages as unknown[]))
    }
    return out
  }

  /** Busca com o que está em memória (sem a tela): títulos de todas, perguntas das à mão. */
  search(q: string): RemoteSearchResult[] {
    return searchUserPrompts(
      this.list().map((c) => ({ id: c.id, title: c.title, cwd: c.cwd, updatedAt: c.updatedAt, messages: this.messagesNow(c.id) ?? [] })),
      q
    )
  }
}
