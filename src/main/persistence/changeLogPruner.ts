/**
 * `change_log` não é dado autoritativo — é o outbox que `PostgresChangeFeed`
 * drena para outras janelas/dispositivos saberem "isso mudou, vá rebuscar" sem
 * fazer polling (ver `postgresChangeFeed.ts`, que lê por `change_id`, nunca
 * por data). Toda conexão nova também faz uma carga completa e autoritativa
 * (`loadSnapshot`/`loadConversations`), então perder uma linha velha daqui só
 * custa algo no caso raro de um dispositivo ficar desconectado pela janela de
 * retenção INTEIRA e depois retomar sem nunca reiniciar o app nesse meio-tempo
 * — qualquer reinício normal já resincroniza pelo caminho autoritativo.
 *
 * Sem limpeza essa tabela cresce para sempre: no servidor real deste app ela
 * chegou a 555 mil linhas / 83 MB por causa de escritas repetidas de um único
 * usuário digitando (ver o bug corrigido em storage.ts).
 */
export const CHANGE_LOG_RETENTION_DAYS = 30

/** Diária: mantém a tabela perto do teto de retenção o tempo todo, em vez de
 *  deixá-la crescer por um mês inteiro entre podas. */
export const CHANGE_LOG_PRUNE_INTERVAL_MS = 24 * 60 * 60_000

export interface ChangeLogPrunable {
  query(sql: string, params?: unknown[]): Promise<unknown>
}

/**
 * Poda periódica de `change_log`. Uma instância por `PostgresRepository`,
 * iniciada em `initialize()` e parada em `close()` — mesmo ciclo de vida do
 * `PostgresChangeFeed`.
 *
 * Uma falha aqui nunca deve derrubar a conexão nem propagar para quem chamou:
 * é manutenção, não uma operação do usuário. Ela só loga e tenta de novo no
 * próximo ciclo.
 */
export class ChangeLogPruner {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(
    private readonly db: ChangeLogPrunable,
    private readonly onError: (error: unknown) => void = () => undefined
  ) {}

  /** Roda a primeira poda logo no boot (um servidor com anos de backlog não
   *  deve esperar 24h pela primeira limpeza) e depois a cada
   *  CHANGE_LOG_PRUNE_INTERVAL_MS. */
  start(): this {
    this.schedule(0)
    return this
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(delay: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => void this.run(), delay)
    this.timer.unref?.()
  }

  private async run(): Promise<void> {
    try {
      await this.db.query('DELETE FROM change_log WHERE changed_at < now() - make_interval(days => $1)', [
        CHANGE_LOG_RETENTION_DAYS
      ])
    } catch (error) {
      this.onError(error)
    } finally {
      this.schedule(CHANGE_LOG_PRUNE_INTERVAL_MS)
    }
  }
}
