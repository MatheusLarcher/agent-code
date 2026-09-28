/** Registra a falha de uma fase da persistência (transição, troca de repositório)
 *  sem vazar senha nem connection string do PostgreSQL no log. */
export function logTransitionFailure(phase: string, cause: unknown): void {
  const error = cause instanceof Error ? cause : new Error(String(cause))
  const code = typeof (cause as { code?: unknown })?.code === 'string'
    ? (cause as { code: string }).code
    : undefined
  const message = error.message
    .replace(/password=[^\s]+/gi, 'password=[redacted]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://[redacted]')
    .slice(0, 1_000)
  console.error('[storage-transition]', JSON.stringify({ phase, name: error.name, code, message }))
}
