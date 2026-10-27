// Raciocínio do agente PRINCIPAL ao vivo, para a tela não ficar em "Pensando…"
// parado por minutos.
//
// Com `includePartialMessages` o SDK repassa o `thinking_delta` de cada bloco
// de raciocínio antes de a mensagem `assistant` chegar inteira. Aqui o texto é
// acumulado por bloco e repassado com throttle, com o MESMO id que o bloco
// completo vai usar depois (`takeIds`): a bolha que nasce no streaming é a que
// a mensagem final reescreve, não uma segunda.
//
// Modelo: toolInputStream.ts (classe com handle/emit, `now()` injetável, sem timer).
import type { RawStreamEvent } from './toolInputStream'

/** Intervalo mínimo entre emissões do MESMO bloco: o raciocínio é longo e só
 *  precisa parecer vivo — 4 por segundo chega, e poupa IPC e render. */
export const THINKING_EMIT_INTERVAL_MS = 250

export interface ThinkingDelta {
  id: string
  /** Texto ACUMULADO do bloco até aqui (a tela substitui, não concatena). */
  text: string
}

interface OpenBlock {
  id: string
  text: string
  lastEmitAt: number
  /** Epoch ms do `content_block_start` — ver `openSince`. */
  startedAt: number
}

/**
 * Acumula o texto de cada bloco `thinking` da mensagem corrente e emite o
 * parcial com throttle por bloco. Os ids dos blocos ficam guardados, na ordem,
 * para `handleAssistant` reusar no bloco completo (`takeIds`).
 *
 * Uma instância por sessão, alimentada SÓ com eventos do agente principal: o
 * `index` de um subagente colidiria com o dele. `message_start` descarta o que
 * sobrou da mensagem anterior (blocos abertos E ids): a ordem real é
 * message_start → blocos → mensagem `assistant` → próximo message_start, então
 * a lista já foi consumida — e se não foi (mensagem que não passou por
 * handleAssistant), não pode vazar para a próxima.
 *
 * O throttle é de borda de subida, sem timer: um delta dentro do intervalo só
 * acumula; o próximo depois dele leva tudo. `content_block_stop` não emite —
 * a mensagem `assistant` traz o bloco inteiro com o mesmo id.
 *
 * `openSince` é o sinal de vida que os deltas NÃO dão: medido ao vivo (Sonnet
 * 5.5 e Opus 5.5, `thinking: adaptive`, `display: 'summarized'`), o
 * `content_block_start` chega no começo do raciocínio e TODOS os
 * `thinking_delta` chegam em rajada no fim do bloco (26 deltas em 3 ms, 4 s
 * depois do start). Durante minutos de raciocínio não há delta nenhum — mas o
 * bloco aberto prova que o modelo está gerando; o heartbeat e o stall usam isso.
 */
export class ThinkingStreams {
  private readonly blocks = new Map<number, OpenBlock>()
  private ids: string[] = []

  constructor(
    private readonly emit: (delta: ThinkingDelta) => void,
    private readonly nextId: () => string,
    private readonly now: () => number = Date.now
  ) {}

  handle(ev: RawStreamEvent): void {
    if (ev.type === 'message_start') {
      this.reset()
      return
    }
    if (typeof ev.index !== 'number') return
    if (ev.type === 'content_block_start') {
      if (ev.content_block?.type !== 'thinking') return
      const id = this.nextId()
      this.blocks.set(ev.index, { id, text: '', lastEmitAt: -Infinity, startedAt: this.now() })
      this.ids.push(id)
    } else if (ev.type === 'content_block_delta') {
      const block = this.blocks.get(ev.index)
      if (!block || ev.delta?.type !== 'thinking_delta' || typeof ev.delta.thinking !== 'string') return
      block.text += ev.delta.thinking
      const t = this.now()
      if (t - block.lastEmitAt < THINKING_EMIT_INTERVAL_MS) return
      block.lastEmitAt = t
      this.emit({ id: block.id, text: block.text })
    } else if (ev.type === 'content_block_stop') {
      this.blocks.delete(ev.index)
    }
  }

  /** Ids dos blocos thinking da mensagem corrente, na ordem em que abriram.
   *  Consome: a lista volta vazia. Vazio = nada veio ao vivo (o chamador gera o id). */
  takeIds(): string[] {
    const ids = this.ids
    this.ids = []
    return ids
  }

  /** Epoch ms do `content_block_start` do bloco thinking ainda sem
   *  `content_block_stop` (o mais antigo, se houver mais de um); null sem bloco aberto. */
  openSince(): number | null {
    let since: number | null = null
    for (const block of this.blocks.values()) {
      if (since === null || block.startedAt < since) since = block.startedAt
    }
    return since
  }

  /** Esquece blocos abertos e ids: fim do turno (markTurnIdle) ou nova mensagem. */
  reset(): void {
    this.blocks.clear()
    this.ids = []
  }
}
