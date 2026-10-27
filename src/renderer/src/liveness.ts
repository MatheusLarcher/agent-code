/**
 * O "último sinal de vida" de cada conversa, fora do React (como o liveInput):
 * o main manda `heartbeat` a cada 5 s com o `lastActivityAt` dele e, chegando
 * qualquer evento de saída (texto, raciocínio, ferramenta, status), o App anota
 * o agora. A linha ao vivo (ChatLive) lê no tique de 1 s que já tem — ninguém
 * assina a store, e um heartbeat nunca custa um render do App.
 *
 * Também guarda o início do bloco de raciocínio ABERTO (`thinkingSince` do
 * heartbeat): com `display: 'summarized'` o texto do raciocínio só chega em
 * rajada no fim, então "último sinal há 3:20" durante o raciocínio assustaria à
 * toa — o bloco aberto é a atividade, com o tempo dela.
 */
class LivenessStore {
  private last = new Map<string, number>()
  private thinkingAt = new Map<string, number>()

  /** Anota um sinal; guarda sempre o MAIOR (um heartbeat atrasado não volta o relógio). */
  note(convId: string, at: number = Date.now()): void {
    if (!Number.isFinite(at)) return
    const cur = this.last.get(convId)
    if (cur === undefined || at > cur) this.last.set(convId, at)
  }

  /** Epoch ms do último sinal, ou undefined sem nenhum. */
  get(convId: string): number | undefined {
    return this.last.get(convId)
  }

  /** O bloco de raciocínio aberto do agente principal (null = nenhum). */
  setThinking(convId: string, since: number | null): void {
    if (since == null || !Number.isFinite(since)) this.thinkingAt.delete(convId)
    else this.thinkingAt.set(convId, since)
  }

  thinking(convId: string): number | null {
    return this.thinkingAt.get(convId) ?? null
  }

  /** Fim do turno: some tudo da conversa. */
  clear(convId: string): void {
    this.last.delete(convId)
    this.thinkingAt.delete(convId)
  }
}

export const liveness = new LivenessStore()
