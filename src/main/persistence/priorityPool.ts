import { AsyncLocalStorage } from 'node:async_hooks'
import type { Pool } from 'pg'

/**
 * Leituras interativas (a tela esperando: abrir conversa, "mostrar mais",
 * painéis) não disputam conexão com o que roda em segundo plano (fila de
 * gravação, telemetria, espelho do transcript, export). Quem serve a tela roda
 * dentro de `interactiveRead`; as consultas feitas ali — em qualquer módulo, por
 * `pool.query` ou `pool.connect` — vão para um pool pequeno reservado.
 */
const lane = new AsyncLocalStorage<'interactive'>()

/** Roda `work` como leitura interativa: as consultas dele usam as conexões reservadas. */
export function interactiveRead<T>(work: () => Promise<T>): Promise<T> {
  return lane.run('interactive', work)
}

export function inInteractiveRead(): boolean {
  return lane.getStore() === 'interactive'
}

/** Conexões reservadas às leituras interativas (o pool de fundo tem 10). */
export const INTERACTIVE_POOL_MAX = 3

/**
 * Liga o desvio: `pool.query`/`pool.connect` chamados dentro de `interactiveRead`
 * vão para `reserved`; fora dele, para o próprio `pool`. `pool.end()` fecha os dois.
 */
export function reserveInteractiveLane(pool: Pool, reserved: Pool): void {
  const query = pool.query.bind(pool) as (...args: unknown[]) => unknown
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown
  const end = pool.end.bind(pool) as () => Promise<void>
  const reservedQuery = reserved.query.bind(reserved) as (...args: unknown[]) => unknown
  const reservedConnect = reserved.connect.bind(reserved) as (...args: unknown[]) => unknown
  pool.query = function (...args: unknown[]) {
    return inInteractiveRead() ? reservedQuery(...args) : query(...args)
  } as typeof pool.query
  pool.connect = function (...args: unknown[]) {
    return inInteractiveRead() ? reservedConnect(...args) : connect(...args)
  } as typeof pool.connect
  pool.end = async function () {
    await Promise.all([end(), reserved.end().catch(() => undefined)])
  } as typeof pool.end
}
