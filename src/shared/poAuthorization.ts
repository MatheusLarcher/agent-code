/**
 * A AUTORIZAÇÃO DO PO para commitar (e/ou dar push) sozinho numa conversa. Nasce
 * da frase do usuário naquela conversa, reconhecida pelo PO na abertura
 * (`AUTORIZAR | commit|commit+push | fila|sempre`), e morre com `REVOGAR`, com o
 * chip ou — no alcance "desta fila" — quando a fila da implantação esvazia.
 */

export interface PoAuthorization {
  /** Push implica commit; commit não implica push. */
  push: boolean
  /** `fila`: só a implantação em andamento (acaba quando ela esvazia); `sempre`: até revogar. */
  scope: 'fila' | 'sempre'
  at: string
  /** No alcance "desta fila": o plano (lote) a que ela pertence. */
  loteId?: string | null
}

/** conversationId → autorização. */
export type PoAuthorizationMap = Record<string, PoAuthorization>

/** "PO autorizado: commit + push · esta fila" / "… · sempre". */
export function poAuthorizationLabel(auth: PoAuthorization): string {
  return `PO autorizado: ${auth.push ? 'commit + push' : 'commit'} · ${auth.scope === 'fila' ? 'esta fila' : 'sempre'}`
}
