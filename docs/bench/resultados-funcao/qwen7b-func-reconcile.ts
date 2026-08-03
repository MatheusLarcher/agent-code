export interface Registro {
  id: string
  updatedAt: number
  /** Quanto do registro está preenchido; usado só para desempate. */
  messages?: unknown[]
}

/**
 * Junta `local` e `remoto` numa lista só, sem duplicar por `id`.
 */
export function reconcile<T extends Registro>(local: T[], remoto: T[]): T[] {
  const mapeado = new Map<string, T>()
  for (const r of [...local, ...remoto]) if (r.id) mapeado.set(r.id, r)
  return Array.from(mapeado.values()).sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
    const ma = a.messages?.length ?? 0
    const mb = b.messages?.length ?? 0
    return mb - ma || local.includes(a) ? -1 : 1
  })
}
