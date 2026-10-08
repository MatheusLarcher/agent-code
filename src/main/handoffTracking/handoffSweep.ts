import type { HandoffTracker } from './handoffTracker'

/**
 * A varredura de fundo do acompanhamento dos envios de handoff (molde:
 * startTaskReaper). Existe porque a sessão que morre calada não manda evento
 * nenhum: sem alguém olhar de fora, o envio ficaria "em execução" para sempre.
 *
 * Cada passada (60 s): na primeira com banco, carrega as conversas com envio em
 * curso (as de antes de o app abrir) e agenda o reconciliador nos projetos com
 * envio saído e não concluído (handoffReconcile.ts); depois grava a fatia de
 * tempo ativo de quem está rodando e marca `parada` o envio sem turno há o
 * limite (10 min).
 */

/** De quanto em quanto tempo a varredura passa. */
export const HANDOFF_SWEEP_MS = 60_000

export type HandoffSweepTarget = Pick<HandoffTracker, 'loadKnown' | 'sweep'>

/** Liga a varredura. Devolve a função que a desliga. Nunca lança nem rejeita. */
export function startHandoffSweep(
  tracker: HandoffSweepTarget,
  pollMs = HANDOFF_SWEEP_MS,
  log: (message: string) => void = () => {}
): () => void {
  let running = false
  let loaded = false
  let stopped = false
  const tick = async (): Promise<void> => {
    // Uma passada por vez: um banco lento não pode empilhar varreduras.
    if (running || stopped) return
    running = true
    try {
      // Sem banco ainda (ou falhou): a próxima passada tenta carregar de novo.
      if (!loaded) loaded = await tracker.loadKnown()
      const outcome = await tracker.sweep()
      if (outcome.stalled > 0) log(`[handoff] varredura: ${outcome.stalled} envio(s) marcado(s) como parada`)
    } catch (err) {
      // Faxina de fundo nunca derruba o app; a próxima passada tenta de novo.
      log(`[handoff] varredura falhou: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), pollMs)
  timer.unref?.()
  void tick()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
