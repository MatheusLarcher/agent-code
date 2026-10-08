import type { Pool, PoolClient } from 'pg'

/**
 * Gancho de teste `AGENT_CODE_DEV_PG_DELAY_MS`: atraso artificial em TODA
 * consulta ao PostgreSQL, para ver a tela com o banco lento. Só no app não
 * empacotado — quem liga é o index.ts (`app.isPackaged`); no instalador o valor
 * fica 0 e o pool nem é envolvido.
 */
let delayMs = 0

/** Até 60 s; valor torto ou negativo = desligado. */
export function configureDevQueryDelay(ms: unknown): number {
  const value = typeof ms === 'string' ? Number(ms) : ms
  delayMs = typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), 60_000) : 0
  return delayMs
}

export function devQueryDelayMs(): number {
  return delayMs
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Cursores e streams (`submit`) devolvem o objeto na hora: esses passam sem atraso. */
function isSubmittable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { submit?: unknown }).submit === 'function'
}

/** Envolve o `query` de cada conexão nova do pool (o `pool.query` também passa por ele). */
export function applyDevQueryDelay(pool: Pool): void {
  if (!delayMs) return
  pool.on('connect', (client: PoolClient) => {
    const original = client.query as (...args: unknown[]) => unknown
    client.query = function (this: PoolClient, ...args: unknown[]) {
      const ms = delayMs
      if (!ms || isSubmittable(args[0])) return original.apply(this, args)
      const callback = args[args.length - 1]
      if (typeof callback === 'function') {
        void wait(ms).then(() => original.apply(this, args))
        return undefined
      }
      return wait(ms).then(() => original.apply(this, args))
    } as typeof client.query
  })
}
