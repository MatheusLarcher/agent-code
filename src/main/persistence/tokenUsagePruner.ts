/**
 * `llm_calls` guarda o detalhe (por chamada) da árvore de consumo de tokens —
 * ver docs/superpowers/specs/2026-09-19-arvore-consumo-tokens-design.md, seção
 * "Retenção (15 dias)". `llm_usage_totals` já foi incrementada na mesma escrita
 * que insere a linha de detalhe (ver `insertLlmCall`) e sobrevive à poda: o
 * agregado por dia/modelo/subagente continua correto mesmo depois que o
 * detalhe de uma chamada específica foi apagado.
 *
 * Esta poda NUNCA deve tocar `llm_usage_totals`.
 */
export const TOKEN_USAGE_RETENTION_DAYS = 15

/** Diária, mesmo raciocínio do `ChangeLogPruner`: mantém a tabela perto do
 *  teto de retenção o tempo todo, em vez de deixá-la crescer por 15 dias
 *  inteiros entre podas. */
export const TOKEN_USAGE_PRUNE_INTERVAL_MS = 24 * 60 * 60_000

/** Cada backend fala seu próprio dialeto (Postgres tem `now()`/`interval`;
 *  SQLite guarda `created_at` como texto ISO e compara por string) — por isso
 *  a poda depende de "apague o que é mais velho que N dias", não de um SQL
 *  fixo, deixando quem implementa decidir a query certa para sua tabela. */
export interface TokenUsagePrunable {
  deleteLlmCallsOlderThan(days: number): Promise<void>
}

/**
 * Poda periódica de `llm_calls`. Uma instância por repositório, iniciada em
 * `initialize()` e parada em `close()` — mesmo ciclo de vida do
 * `ChangeLogPruner`.
 *
 * Uma falha aqui nunca deve derrubar a conexão nem propagar para quem chamou:
 * é manutenção, não uma operação do usuário. Ela só loga e tenta de novo no
 * próximo ciclo.
 */
export class TokenUsagePruner {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(
    private readonly db: TokenUsagePrunable,
    private readonly onError: (error: unknown) => void = () => undefined
  ) {}

  /** Roda a primeira poda logo no boot (backlog de dias não deve esperar 24h
   *  pela primeira limpeza) e depois a cada TOKEN_USAGE_PRUNE_INTERVAL_MS. */
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
      await this.db.deleteLlmCallsOlderThan(TOKEN_USAGE_RETENTION_DAYS)
    } catch (error) {
      this.onError(error)
    } finally {
      this.schedule(TOKEN_USAGE_PRUNE_INTERVAL_MS)
    }
  }
}
