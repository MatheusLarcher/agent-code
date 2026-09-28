import type { PoolClient, QueryConfig } from 'pg'
import { isTransientPostgresError } from './postgresRetry'

/**
 * Tetos de tempo das sessões PostgreSQL do app. Sem eles, uma consulta que não
 * termina segura a vaga do pool PARA SEMPRE — e com as 10 vagas presas todo
 * pedido morre em "timeout exceeded when trying to connect" (a espera de 8s
 * por uma vaga), sem nem tentar abrir conexão nova.
 *
 * - `lock_timeout`: espera por trava (FOR UPDATE, advisory lock). As travas do
 *   app duram milissegundos; esperar mais que isto é outro processo travado com
 *   a linha na mão (ex.: uma sessão órfã de outra máquina "idle in transaction").
 * - `statement_timeout`: qualquer comando no servidor. Generoso: corta o que
 *   travou, não trabalho real (importação/poda são muitos comandos pequenos).
 * - `idle_in_transaction_session_timeout`: o servidor derruba uma sessão NOSSA
 *   que abriu transação e parou de falar (processo congelado, socket morto no
 *   meio), soltando as travas que ela segurava para os outros.
 * - `query_timeout` (lado cliente, do `pg`): socket meio morto não recebe o
 *   cancelamento do servidor; sem isto a consulta espera uma resposta que nunca
 *   vem. Maior que o `statement_timeout` para o servidor cortar primeiro quando
 *   ele ainda estiver alcançável — aí a conexão continua utilizável.
 *
 * Os três primeiros são aplicados por SET depois de conectar
 * (postgresSessionSetup.ts), nunca como parâmetro de startup — o PgBouncer
 * recusaria a conexão.
 */
export const POSTGRES_LOCK_TIMEOUT_MS = 15_000
export const POSTGRES_STATEMENT_TIMEOUT_MS = 120_000
export const POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000
export const POSTGRES_QUERY_TIMEOUT_MS = 130_000

/**
 * Teto POR CONSULTA dos caminhos quentes que não podem esperar os 130s acima:
 * o append do espelho (o SDK desiste da chamada em 60s) e a renovação do lease
 * (batimento a cada 20s, lease de 60s). Ali a única espera legítima é por uma
 * trava de linha que dura milissegundos; passou disto, a conexão travou e o
 * pedido falha logo, soltando a vaga, em vez de segurá-la por 2 minutos.
 */
export const POSTGRES_CALL_TIMEOUT_MS = 15_000

/** `connectionTimeoutMillis` do pool: espera por vaga livre ou pelo handshake
 *  de uma conexão nova (o `onConnect` com o SET vem DEPOIS e tem teto próprio,
 *  SESSION_SETUP_TIMEOUT_MS). */
export const POSTGRES_CONNECT_TIMEOUT_MS = 8_000

/**
 * `lock_timeout` das transações dos caminhos quentes (append do espelho,
 * renovação do lease), por `SET LOCAL`. Fica bem ABAIXO do teto do cliente por
 * consulta (POSTGRES_CALL_TIMEOUT_MS) para o servidor cortar primeiro uma
 * espera por trava: aí chega o erro limpo 55P03, o ROLLBACK funciona e a
 * conexão volta ao pool — em vez de o cliente desistir às cegas ("Query read
 * timeout") e descartar a conexão com a consulta ainda ativa no servidor.
 */
export const HOT_PATH_LOCK_TIMEOUT_MS = 5_000

/** `idle_in_transaction_session_timeout` da transação do append, por
 *  `SET LOCAL`: se o COMMIT se perder num socket meio morto, a transação órfã
 *  aborta logo no servidor e a pendência do COMMIT ambíguo
 *  (postgresCommitAmbiguity.ts) se resolve como 'aborted' na próxima chamada,
 *  em vez de ficar 'in progress' pelo minuto inteiro do teto da sessão. Entre
 *  duas consultas do append o cliente só gasta milissegundos. */
export const APPEND_IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000

/** Consulta com `query_timeout` próprio (o `pg` aceita no objeto da consulta;
 *  os tipos do @types/pg ainda não o declaram). */
export function timedQuery(text: string, values: unknown[] | undefined, timeoutMs: number): QueryConfig {
  const config: QueryConfig & { query_timeout: number } = { text, query_timeout: timeoutMs }
  if (values) config.values = values
  return config
}

/** `query_timeout` do `pg` venceu: a consulta foi enviada e a resposta nunca
 *  chegou. A conexão fica com a consulta presa como ativa — não serve mais. */
export function isQueryReadTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'Query read timeout'
}

/**
 * Fecha a transação que falhou e diz se a conexão pode voltar ao pool.
 * Devolve o erro a passar para `client.release()`: `undefined` quando o
 * ROLLBACK confirmou que a sessão está limpa; um erro quando a conexão caiu,
 * travou (query_timeout) ou o ROLLBACK falhou — aí o pool descarta o cliente
 * em vez de entregá-lo, envenenado, ao próximo pedido.
 */
export async function rollbackOrDiscard(client: Pick<PoolClient, 'query'>, error: unknown): Promise<Error | undefined> {
  const asError = error instanceof Error ? error : new Error(String(error))
  // Com a consulta presa como ativa, o ROLLBACK só entraria na fila atrás dela
  // e esperaria outro query_timeout inteiro para nada.
  if (isQueryReadTimeout(error) || isTransientPostgresError(error)) return asError
  try {
    await client.query('ROLLBACK')
    return undefined
  } catch (rollbackError) {
    return rollbackError instanceof Error ? rollbackError : asError
  }
}
