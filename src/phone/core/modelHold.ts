/**
 * A troca de modelo/esforço feita no celular ainda não confirmada pelo retrato do
 * PC. Um /api/state que já estava a caminho (o retrato de 4 s) traria o valor
 * antigo e desfaria a escolha na tela; com a trava, o celular mostra a escolha até
 * o retrato do PC trazê-la (ou o prazo vencer — o PC recusou, e a tela volta).
 */
import type { ConvSummary } from './types'

/** Quanto a troca segura a tela contra um retrato velho (alguns retratos de 4 s). */
export const MODEL_HOLD_MS = 15_000

interface Hold {
  convId: string
  model?: string
  effort?: string
  until: number
}

export class ModelHold {
  private hold: Hold | null = null
  constructor(private readonly now: () => number = Date.now) {}

  set(convId: string, patch: { model?: string; effort?: string }): void {
    this.hold = {
      convId,
      ...(patch.model ? { model: patch.model } : {}),
      ...(patch.effort ? { effort: patch.effort } : {}),
      until: this.now() + MODEL_HOLD_MS
    }
  }

  clear(): void {
    this.hold = null
  }

  /** O retrato com a troca em espera por cima; o que já a traz (ou o prazo vencido) a encerra. */
  apply(list: ConvSummary[]): ConvSummary[] {
    const h = this.hold
    if (!h) return list
    if (this.now() > h.until) {
      this.hold = null
      return list
    }
    return list.map((c) => {
      if (c.id !== h.convId) return c
      if ((h.model === undefined || c.model === h.model) && (h.effort === undefined || c.effort === h.effort)) {
        this.hold = null
        return c
      }
      return { ...c, ...(h.model !== undefined ? { model: h.model } : {}), ...(h.effort !== undefined ? { effort: h.effort } : {}) }
    })
  }
}
