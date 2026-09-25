/** Estado da pausa do roteamento TypeSafe (Modo Automático). */
export interface TypeSafePauseStatus {
  /** ms epoch até quando as consultas estão suspensas; null = sem pausa. */
  pausedUntil: number | null
  /** Motivo em português, para o aviso e a tela de configuração. */
  reason: string | null
}
