import type { PoCall, PoPhase } from './poPrompt'
import type { PoDeferred } from './poQueue'

/**
 * O estado do PO por conversa (po.ts): o turno em curso, a fila e o cooldown de
 * cada fase e os cartões de outra conversa adotados. Mora aqui pelo teto de
 * tamanho de po.ts.
 */

export interface ConvState {
  userText: string | null
  cwd: string
  calls: PoCall[]
  fired: boolean
  /** A resposta final do turno (o texto do `result` ou o último bloco): vai
   *  inteira para o fechamento e, quando a próxima mensagem chega, para a
   *  abertura como a do turno ANTERIOR — e zera. */
  reply: string | null
  /** Os blocos de texto final do agente principal neste turno, em ordem. */
  texts: string[]
  /** Uma janela de cooldown por FASE: a abertura não pode gastar a do
   *  fechamento, senão o turno que acabou de ser aberto nunca seria auditado. */
  lastRunAt: Record<PoPhase, number>
  /** Uma fila por FASE, pelo mesmo motivo do cooldown ser por fase: o turno
   *  que a abertura pulou tem que voltar numa abertura futura, não ser
   *  engolido pelo fechamento que rodar primeiro (e vice-versa) — cada fase
   *  audita a evidência da SUA fila, nunca a da outra. Um pedido que nunca
   *  passou pelo PO é exatamente o buraco que este recurso existe para fechar. */
  deferred: Record<PoPhase, PoDeferred | null>
  /** Cancelador do flush agendado para o fim do cooldown desta fase (null: nada
   *  agendado), para o acumulado não esperar um próximo turno que pode nunca
   *  chegar. Um só por fase, e a retentativa usa o MESMO lugar: as duas coisas
   *  são "julgar a fila desta fase mais tarde". */
  flushCancel: Record<PoPhase, (() => void) | null>
  /** Retentativas SEGUIDAS já agendadas nesta fase (teto: PO_MAX_RETRIES).
   *  Zera numa auditoria que chega ao fim — inclusive o "não" do gate — e
   *  quando um turno real dispara a análise: aí a falha anterior é passado. */
  retries: Record<PoPhase, number>
  /** O que ainda roda em SEGUNDO PLANO (descrições do último snapshot
   *  `background-tasks`, vazio = nada). Estado vivo, não evidência de turno:
   *  o fechamento real o congela no `result`; o flush usa o de agora. */
  background: readonly string[]
  /** Cartões de OUTRA conversa que a abertura desta pôs em andamento (poForeign.ts). */
  adopted: Set<string>
}

/** `PoDeps.scheduleFlush` padrão: `setTimeout`/`clearTimeout` reais, sem
 *  segurar o processo vivo (`unref`) — um flush pendente não pode ser o que
 *  impede o app de fechar. */
export function defaultScheduleFlush(delayMs: number, fn: () => void): () => void {
  const timer = setTimeout(fn, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export function newConvState(): ConvState {
  return {
    userText: null,
    cwd: '',
    calls: [],
    fired: false,
    reply: null,
    texts: [],
    lastRunAt: { open: 0, close: 0 },
    deferred: { open: null, close: null },
    flushCancel: { open: null, close: null },
    retries: { open: 0, close: 0 },
    background: [],
    adopted: new Set()
  }
}
