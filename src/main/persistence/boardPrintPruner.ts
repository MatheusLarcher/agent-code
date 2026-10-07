/**
 * A faxina dos PRINTS dos cartões: apagados 30 dias depois de a tarefa ser
 * concluída (o card reaberto antes disso guarda os prints), e o print de
 * cartão que sumiu sai com a mesma idade. Mesmo ciclo do `ContextBlobPruner`:
 * uma instância por repositório, iniciada em `initialize()` e parada em
 * `close()`; a primeira passada roda no boot e depois a cada 24 h. Manutenção:
 * uma falha só loga e tenta de novo no ciclo seguinte.
 */
export const BOARD_PRINT_RETENTION_MS = 30 * 24 * 60 * 60_000
export const BOARD_PRINT_PRUNE_INTERVAL_MS = 24 * 60 * 60_000

export interface BoardPrintPrunable {
  pruneBoardItemPrints(cutoffIso: string): Promise<number>
}

export class BoardPrintPruner {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(
    private readonly db: BoardPrintPrunable,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly clock: () => number = Date.now
  ) {}

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

  /** Uma passada (o teste chama direto). */
  async run(): Promise<void> {
    try {
      await this.db.pruneBoardItemPrints(new Date(this.clock() - BOARD_PRINT_RETENTION_MS).toISOString())
    } catch (error) {
      this.onError(error)
    } finally {
      this.schedule(BOARD_PRINT_PRUNE_INTERVAL_MS)
    }
  }
}
