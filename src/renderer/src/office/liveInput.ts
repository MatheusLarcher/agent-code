// Store do código ao vivo (`tool-input-delta`) para o monitor do escritório.
//
// Fica FORA do React de propósito: o evento chega até 10 vezes por segundo por
// bloco, e passar por setState re-renderizaria o App inteiro a cada pedaço. O
// handler do `agent:event` (App.tsx) entrega aqui e retorna, sem reducer nem
// persistência; quem quer ver assina.
//
// "Tela fechada descarta": sem assinante para a conversa, o push joga o evento
// fora na hora — nada fica guardado esperando alguém abrir o painel. Com
// assinante, guarda só o ÚLTIMO evento de cada bloco (é um retrato completo das
// últimas linhas, não um diff), para quem abrir o zoom no meio da escrita ler o
// estado atual por `latest`; o `done` limpa o bloco.
import type { ChatEvent } from '@shared/ipc'

export type ToolInputDelta = Extract<ChatEvent, { kind: 'tool-input-delta' }>
export type LiveInputListener = (event: ToolInputDelta) => void

interface Subscription {
  /** `null` = todos os blocos da conversa. */
  toolUseId: string | null
  cb: LiveInputListener
}

export class LiveInputStore {
  private readonly subs = new Map<string, Set<Subscription>>()
  /** convId → toolUseId → último evento não-`done`. A ordem de inserção do Map é
   *  a ordem do mais antigo para o mais recente (reinserido a cada push). */
  private readonly last = new Map<string, Map<string, ToolInputDelta>>()

  push(convId: string, event: ToolInputDelta): void {
    const subs = this.subs.get(convId)
    if (!subs || subs.size === 0) return
    let blocks = this.last.get(convId)
    if (!blocks) {
      blocks = new Map()
      this.last.set(convId, blocks)
    }
    blocks.delete(event.toolUseId)
    if (!event.done) blocks.set(event.toolUseId, event)
    // Cópia: um assinante que cancela dentro do callback não pula o seguinte.
    for (const sub of [...subs]) {
      if (sub.toolUseId !== null && sub.toolUseId !== event.toolUseId) continue
      try {
        sub.cb(event)
      } catch (error) {
        // Um painel com defeito não pode derrubar o handler do agent:event.
        console.error('[liveInput] assinante falhou:', error)
      }
    }
  }

  /** Assina os eventos da conversa (`toolUseId` null = qualquer bloco). Devolve
   *  o cancelamento; o último assinante a sair leva junto o que estava guardado. */
  subscribe(convId: string, toolUseId: string | null, cb: LiveInputListener): () => void {
    const sub: Subscription = { toolUseId, cb }
    let subs = this.subs.get(convId)
    if (!subs) {
      subs = new Set()
      this.subs.set(convId, subs)
    }
    subs.add(sub)
    return () => {
      const current = this.subs.get(convId)
      if (!current?.delete(sub) || current.size > 0) return
      this.subs.delete(convId)
      this.last.delete(convId)
    }
  }

  /** O estado atual de um bloco ainda aberto (ou, com `null`, do mais recente da
   *  conversa). `undefined` sem assinante, sem bloco aberto ou depois do `done`. */
  latest(convId: string, toolUseId: string | null): ToolInputDelta | undefined {
    const blocks = this.last.get(convId)
    if (!blocks) return undefined
    if (toolUseId !== null) return blocks.get(toolUseId)
    let newest: ToolInputDelta | undefined
    for (const event of blocks.values()) newest = event
    return newest
  }
}

/** A instância do app: uma só, alimentada pelo handler do `agent:event`. */
export const liveInput = new LiveInputStore()
