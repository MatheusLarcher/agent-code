/**
 * Quantas vezes cada envio já foi RETOMADO depois de parar por inatividade.
 * Em memória, de propósito: perde no reinício do app, e tudo bem — é só o freio
 * que impede a retomada em laço (a 2ª parada segura a fila com motivo).
 */

const resumes = new Map<string, number>()

export function resumeCount(envioId: string): number {
  return resumes.get(envioId) ?? 0
}

export function noteResume(envioId: string): number {
  const n = resumeCount(envioId) + 1
  resumes.set(envioId, n)
  return n
}

/** A retomada que não chegou a sair (o despacho falhou): não conta. */
export function forgetResume(envioId: string): void {
  const n = resumeCount(envioId) - 1
  if (n <= 0) resumes.delete(envioId)
  else resumes.set(envioId, n)
}

/** Só para teste. */
export function resetResumes(): void {
  resumes.clear()
}
