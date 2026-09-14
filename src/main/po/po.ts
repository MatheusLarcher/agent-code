import { askObserver } from '../observerQuery'
import type { BoardConfig, ChatEvent } from '../../shared/ipc'
import type { BoardService } from '../board/boardService'
import {
  buildPoPrompt,
  parsePoVerdict,
  PO_COOLDOWN_MS,
  PO_MAX_CALLS,
  rejectUnsafeOps,
  summarizeCall,
  type PoCall
} from './poPrompt'

/**
 * O PO: a segunda metade do que torna o quadro confiável.
 *
 * A primeira é a trava (`planGate`), que garante que o plano EXISTA. Esta
 * garante que ele fique honesto até o fim: o buraco que nem a trava nem o
 * snapshot do CLI cobrem é "o agente fez e esqueceu de marcar", que não tem
 * momento fixo para travar — só dá para auditar depois.
 *
 * Mesmas três invariantes do vigia, pelos mesmos motivos:
 *
 * 1. **Não fala com o agente principal.** Ele escreve no quadro, não no chat.
 * 2. **Não interrompe nada.** Falha de rede/SDK/banco degrada em silêncio.
 * 3. **Fala pouco.** Uma análise por turno, no fim do turno, com cooldown.
 *
 * Roda no `result` e não no meio do turno de propósito: é no fim que dá para
 * ver o que terminou, e rodar duas vezes custaria o dobro para responder a
 * mesma pergunta com menos informação.
 */

export interface PoDeps {
  /** Lido a cada análise: desligar na tela vale na hora. */
  config(): BoardConfig
  board: BoardService
  /** A chamada ao modelo. Injetável para o teste não subir o SDK. */
  ask?(prompt: string, model: string): Promise<string>
  now?(): number
}

interface ConvState {
  /** null = nenhum turno do usuário em aberto; sem isso o PO não roda. */
  userText: string | null
  cwd: string
  calls: PoCall[]
  fired: boolean
  lastRunAt: number
}

export class Po {
  private readonly state = new Map<string, ConvState>()

  constructor(private readonly deps: PoDeps) {}

  /** Um turno começou. Retomada de sessão e recuperação não passam por aqui —
   *  sem pedido do usuário não há trabalho novo para auditar. */
  noteUserMessage(convId: string, cwd: string, text: string): void {
    const conv = this.conv(convId)
    conv.userText = text
    conv.cwd = cwd
    conv.calls = []
    conv.fired = false
  }

  /** Alimentado pelo tee de eventos do main. Nunca lança. */
  observe(convId: string, event: ChatEvent): void {
    const conv = this.conv(convId)
    if (conv.userText === null || conv.fired) return
    if (event.kind === 'tool-use') {
      // Guarda as ÚLTIMAS chamadas, não as primeiras: um turno começa lendo e
      // termina escrevendo/testando, e é o fim que prova que a tarefa acabou.
      // Truncar pelo começo deixava o PO cego justamente nos turnos longos —
      // os que mais acumulam cartão esquecido.
      conv.calls.push({ tool: event.name, detail: summarizeCall(event.name, event.input) })
      if (conv.calls.length > PO_MAX_CALLS) conv.calls.shift()
      return
    }
    if (event.kind === 'result') {
      void this.run(convId)
      return
    }
    // Turno que morreu em erro não é "esqueceu de marcar" — é falha. Fecha sem
    // analisar, para o PO não concluir tarefa de um trabalho que não terminou.
    if (event.kind === 'error') conv.userText = null
  }

  dispose(convId: string): void {
    this.state.delete(convId)
  }

  private conv(convId: string): ConvState {
    let conv = this.state.get(convId)
    if (!conv) {
      conv = { userText: null, cwd: '', calls: [], fired: false, lastRunAt: 0 }
      this.state.set(convId, conv)
    }
    return conv
  }

  private async run(convId: string): Promise<void> {
    const conv = this.conv(convId)
    if (conv.userText === null || conv.fired) return
    conv.fired = true

    const cfg = this.deps.config()
    if (!cfg.po.enabled) return
    const now = this.deps.now?.() ?? Date.now()
    if (now - conv.lastRunAt < PO_COOLDOWN_MS) return
    conv.lastRunAt = now

    try {
      // A ingestão do snapshot é assíncrona: sem esperar por ela, o PO leria o
      // quadro de antes deste turno e reclamaria de algo já resolvido.
      await this.deps.board.settled(convId)
      const cards = await this.deps.board.list(conv.cwd, { conversationId: convId })
      // `null` (quadro ilegível) e `[]` (nada declarado) não viram chamada ao
      // modelo — não há o que auditar em nenhum dos dois casos.
      if (!cards || cards.length === 0) return

      const prompt = buildPoPrompt({
        userText: conv.userText,
        cards: cards.map((card) => ({
          id: card.id,
          title: card.poTitle ?? card.sourceTitle,
          status: card.poStatus ?? card.sourceStatus
        })),
        calls: conv.calls
      })
      const raw = await (this.deps.ask ?? askPo)(prompt, cfg.po.model)
      const ops = rejectUnsafeOps(
        parsePoVerdict(raw, cards.map((card) => card.id)),
        cards
      )
      if (ops.length === 0) return

      const first = cards[0]
      for (const op of ops) {
        if (op.kind === 'complete') {
          await this.deps.board.applyPo({ id: op.id, poStatus: 'completed', poReason: op.reason })
        } else if (op.kind === 'retitle') {
          await this.deps.board.applyPo({ id: op.id, poTitle: op.title })
        } else {
          await this.deps.board.createPoItem({
            projectId: first.projectId,
            projectCwd: first.projectCwd,
            conversationId: convId,
            title: op.title,
            status: 'pending',
            reason: op.reason
          })
        }
      }
    } catch {
      // O observador não pode derrubar o observado, nem o quadro.
    }
  }
}

/** A chamada real é a mesma de todo observador do app (ver observerQuery.ts). */
export const askPo = askObserver
