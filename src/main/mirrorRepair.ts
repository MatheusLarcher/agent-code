import { isTransientPostgresError } from './persistence/postgresRetry'
import { StorageReconnector } from './persistence/storageReconnect'

/**
 * Reparo do espelho do transcript depois de um `mirror_error`.
 *
 * O SDK descarta o lote que não conseguiu espelhar, mas o transcript LOCAL
 * continua íntegro (ele só espelha depois de gravar em disco). Antes, a sessão
 * ficava bloqueada para sempre: uma queda de rede de 3 minutos travava a
 * conversa até o app ser reaberto. Agora o reparo (reenvio do transcript local +
 * a mesma verificação do fim de turno, injetados por quem cria a sessão) é
 * tentado com backoff até o banco voltar.
 *
 * Uma tentativa por vez: o timer e o envio do usuário compartilham a mesma.
 */
export type MirrorRepairOutcome = 'restored' | 'pending' | 'failed'

/** Quanto um envio espera por uma tentativa de reparo antes de avisar. */
export const MIRROR_REPAIR_SEND_TIMEOUT_MS = 10_000

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Textos da sessão, aqui para não inchar agentSession.ts. */
export const mirrorRepairText = {
  started: (cause: string | undefined): string =>
    `Falha ao espelhar o transcript no banco${cause ? ` (${cause})` : ''}. O transcript local está íntegro: ` +
    'vou reenviá-lo sozinho assim que o banco responder. Novos envios esperam o reparo.',
  restored: 'Espelhamento restaurado: o transcript local foi reenviado ao banco e verificado. Envios liberados.',
  waiting:
    'O banco ainda não respondeu, então o espelhamento do transcript não foi reparado. Sua mensagem está guardada ' +
    'e segue sozinha assim que o reparo terminar — continuo tentando automaticamente.',
  queued:
    'O banco ainda não respondeu, então o espelhamento do transcript não foi reparado e a mensagem não foi enviada. ' +
    'Ela voltou para a fila de espera desta conversa e sai sozinha quando o reparo terminar — continuo tentando automaticamente.',
  gaveUp: (error: unknown): string =>
    `Não consegui reparar o espelhamento do transcript: ${detailOf(error)}. Novos envios continuam bloqueados; ` +
    'reabra a conversa depois de corrigir a persistência.',
  notSent:
    'Mensagem não enviada: o espelhamento do transcript não pôde ser reparado. Reabra a conversa depois de corrigir a persistência.'
}

export interface MirrorRepairOptions {
  /** Uma tentativa completa: replay + verificação. Rejeita com o erro dela. */
  attempt: () => Promise<void>
  onRestored: () => void
  /** Falha que repetir não resolve: o reparo para e a sessão segue bloqueada. */
  onGiveUp: (error: unknown) => void
  onAttemptFailed?: (error: unknown) => void
  isRetryable?: (error: unknown) => boolean
  delays?: readonly number[]
}

export class MirrorRepair {
  private active = false
  /** As tentativas automáticas já podem rodar (o `startAfter` do `begin` resolveu). */
  private automatic = false
  private cycle = 0
  private readonly reconnector: StorageReconnector
  private readonly waiters = new Set<(restored: boolean) => void>()

  constructor(private readonly options: MirrorRepairOptions) {
    this.reconnector = new StorageReconnector({
      attempt: async () => {
        try {
          await options.attempt()
        } catch (error) {
          if (this.active) options.onAttemptFailed?.(error)
          throw error
        }
        // Descartado no meio da tentativa: não anuncia nada numa sessão morta.
        if (this.active) this.settle(true)
      },
      shouldRun: () => this.active,
      isRetryable: options.isRetryable ?? isTransientPostgresError,
      onGiveUp: (error) => {
        if (!this.active) return
        this.settle(false)
        options.onGiveUp(error)
      },
      delays: options.delays
    })
  }

  /** Há um reparo em andamento (envios devem esperar por ele). */
  get pending(): boolean {
    return this.active
  }

  /**
   * Liga o reparo. As tentativas automáticas começam quando `startAfter`
   * resolver (fim do turno em andamento: o espelho vivo ainda pode estar
   * gravando). `tryNow` não espera por isso. No-op se já está pendente.
   */
  begin(startAfter?: Promise<void>): boolean {
    if (this.active) return false
    this.active = true
    this.automatic = !startAfter
    const cycle = ++this.cycle
    if (startAfter) {
      void startAfter.then(() => {
        if (cycle !== this.cycle) return
        this.automatic = true
        this.reconnector.schedule()
      })
    } else this.reconnector.schedule()
    return true
  }

  /** A persistência voltou: tenta já, zerando o backoff, em vez de esperar o
   *  degrau em curso (que chega a 1 hora numa queda longa). Respeita o
   *  `startAfter` do `begin`: com o turno ainda gravando, não antecipa nada. */
  kick(): void {
    if (!this.active || !this.automatic) return
    void this.reconnector.now().catch(() => undefined)
  }

  /** Tenta já, esperando no máximo `timeoutMs`. Estourado o prazo a tentativa
   *  continua; quem precisa do fim chama `whenSettled`. */
  async tryNow(timeoutMs: number): Promise<MirrorRepairOutcome> {
    if (!this.active) return 'restored'
    const attempt = this.reconnector.now().then(
      () => 'restored' as const,
      () => (this.active ? 'pending' : 'failed')
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'pending'>((resolve) => {
      timer = setTimeout(() => resolve('pending'), timeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([attempt, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** `true` quando o espelho foi restaurado; `false` se o reparo desistiu ou a
   *  sessão foi descartada. */
  whenSettled(): Promise<boolean> {
    if (!this.active) return Promise.resolve(true)
    return new Promise((resolve) => this.waiters.add(resolve))
  }

  dispose(): void {
    if (!this.active) return
    this.settle(false)
  }

  private settle(restored: boolean): void {
    this.active = false
    this.reconnector.cancel()
    for (const resolve of this.waiters) resolve(restored)
    this.waiters.clear()
    if (restored) this.options.onRestored()
  }
}
