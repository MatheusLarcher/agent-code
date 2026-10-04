/**
 * `context_blob` guarda cada texto do histórico do contexto uma vez só,
 * endereçado pelo conteúdo, e vários turnos apontam para o mesmo blob. Por isso
 * apagar um turno (ou a conversa inteira) não apaga blob nenhum: o que ficou sem
 * referência sai aqui. Não há prazo de retenção — só "ninguém mais aponta".
 *
 * Mesmo ciclo de vida e mesma regra do `TokenUsagePruner`: uma instância por
 * repositório, iniciada em `initialize()` e parada em `close()`; a primeira poda
 * roda logo no boot e depois a cada CONTEXT_BLOB_PRUNE_INTERVAL_MS. É
 * manutenção, não operação do usuário: uma falha só loga e tenta de novo no
 * ciclo seguinte.
 */
export const CONTEXT_BLOB_PRUNE_INTERVAL_MS = 24 * 60 * 60_000

export interface ContextBlobPrunable {
  pruneOrphanContextBlobs(): Promise<number>
}

export class ContextBlobPruner {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(
    private readonly db: ContextBlobPrunable,
    private readonly onError: (error: unknown) => void = () => undefined
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

  private async run(): Promise<void> {
    try {
      await this.db.pruneOrphanContextBlobs()
    } catch (error) {
      this.onError(error)
    } finally {
      this.schedule(CONTEXT_BLOB_PRUNE_INTERVAL_MS)
    }
  }
}
