/** Primeira espera depois de uma queda: a rede costuma voltar segundos depois
 *  de o PC sair da suspensão. */
export const RECONNECT_BASE_DELAY_MS = 1_000
/** Teto da espera (1 hora). Um servidor fora por muito tempo não é martelado;
 *  resume, desbloqueio, volta da rede e o botão manual tentam na hora e zeram a
 *  espera, então o teto só vale para quem não tem nenhum gatilho. */
export const RECONNECT_MAX_DELAY_MS = 3_600_000

/** Espera antes da próxima tentativa, dado quantas falharam seguidas desde a
 *  última queda (ou do último gatilho imediato): 1s, 2s, 4s, ... até 3600s.
 *  Pura, para ser reaproveitada fora da persistência. */
export function reconnectDelayMs(
  failures: number,
  baseMs: number = RECONNECT_BASE_DELAY_MS,
  maxMs: number = RECONNECT_MAX_DELAY_MS
): number {
  // NaN/negativo contam como nenhuma falha. O expoente é limitado porque o teto
  // chega muito antes e 2^1024 já seria Infinity.
  const steps = failures > 0 ? Math.min(Math.floor(failures), 64) : 0
  return Math.min(baseMs * 2 ** steps, maxMs)
}

export interface StorageReconnectorOptions {
  /** Uma tentativa de reabrir o backend; rejeita com o erro dela. */
  attempt: () => Promise<void>
  /** Ainda faz sentido tentar sozinho (offline, sem transição, app aberto)? */
  shouldRun: () => boolean
  /** Falha que repetir não resolve (senha, TLS, permissão) encerra o ciclo. */
  isRetryable: (error: unknown) => boolean
  onGiveUp?: (error: unknown) => void
  /** Degraus fixos em vez de `reconnectDelayMs` (o último se repete). */
  delays?: readonly number[]
}

/** Reabre a persistência sozinho depois de uma queda, com backoff.
 *
 * Antes não existia: uma queda do PostgreSQL (típico ao voltar da suspensão)
 * deixava o app na tela "Persistência indisponível" até o usuário clicar em
 * "Tentar novamente". Uma tentativa por vez: o botão manual, os avisos do SO
 * (resume, desbloqueio, rede de volta) e o timer compartilham a mesma tentativa
 * em andamento. */
export class StorageReconnector {
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  private inFlight: Promise<void> | null = null

  constructor(private readonly options: StorageReconnectorOptions) {}

  private delayFor(failures: number): number {
    const delays = this.options.delays
    if (delays?.length) return delays[Math.min(failures, delays.length - 1)]
    return reconnectDelayMs(failures)
  }

  /** Agenda a próxima tentativa automática (no-op se já houver uma agendada). */
  schedule(): void {
    if (this.timer || !this.options.shouldRun()) return
    const delay = this.delayFor(this.attempts)
    this.attempts += 1
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.options.shouldRun()) void this.run().catch(() => undefined)
    }, delay)
    this.timer.unref?.()
  }

  /** Tenta já, zerando o backoff — pedido explícito (botão ou volta da
   *  suspensão). Se uma tentativa já está em curso, espera a mesma. */
  now(): Promise<void> {
    this.cancel()
    this.attempts = 0
    return this.run()
  }

  /** Tenta já com OUTRA tentativa (ex.: configuração corrigida pelo usuário),
   *  zerando o backoff. Nunca em paralelo com a automática: espera a que estiver
   *  em curso terminar e só então roda — e quem pedir uma tentativa enquanto
   *  isso divide esta. Falhar não encerra o ciclo automático (que segue com o
   *  que estiver salvo): repetível ou não, a próxima automática é agendada. */
  nowWith(attempt: () => Promise<void>): Promise<void> {
    this.cancel()
    this.attempts = 0
    const previous = this.inFlight
    return this.track(async () => {
      await previous?.catch(() => undefined)
      // A que estava em curso pode ter falhado e agendado a próxima.
      this.cancel()
      this.attempts = 0
      try {
        await attempt()
        this.attempts = 0
      } catch (error) {
        this.schedule()
        throw error
      }
    })
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private run(): Promise<void> {
    if (this.inFlight) return this.inFlight
    return this.track(async () => {
      try {
        await this.options.attempt()
        this.attempts = 0
      } catch (error) {
        if (this.options.isRetryable(error)) this.schedule()
        else this.options.onGiveUp?.(error)
        throw error
      }
    })
  }

  /** Registra `work` como A tentativa em curso (as outras a dividem). */
  private track(work: () => Promise<void>): Promise<void> {
    const shared = work().finally(() => {
      if (this.inFlight === shared) this.inFlight = null
    })
    this.inFlight = shared
    return shared
  }
}
