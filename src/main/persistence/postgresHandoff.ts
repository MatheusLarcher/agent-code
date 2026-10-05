import type { Pool, PoolClient } from 'pg'
import type { HandoffEnvio } from '../../shared/handoffTracking'
import {
  HANDOFF_ENTREGA_COLUMNS,
  HANDOFF_ENVIO_COLUMNS,
  handoffEntregaFromRow,
  handoffEntregaPatchWrites,
  handoffEnvioFromRow,
  handoffEnvioPatchWrites,
  normalizeHandoffQuery,
  prepareHandoffEnvio,
  type HandoffColumnWrite,
  type HandoffEntregaRow,
  type HandoffEnvioRow,
  type NormalizedHandoffTimeAdd
} from '../handoffTracking/handoffModel'
import { decodePostgresText, encodePostgresText } from './postgresEncoding'
import { rollbackOrDiscard } from './postgresTimeouts'
import type { HandoffEntregaPatch, HandoffEnvioCreate, HandoffEnvioPatch, HandoffEnvioQuery } from './types'

/**
 * Registro dos envios de handoff no PostgreSQL (migration 17). O
 * `PostgresRepository` só delega para cá.
 *
 * Texto livre (títulos, conteúdo, motivos) passa por encodePostgresText — o
 * PostgreSQL não guarda NUL —; ids e datas não. O driver devolve `timestamptz`
 * como `Date` e `bigint` como texto: a leitura converte para a mesma forma do
 * SQLite (ISO, number) antes do mapeamento compartilhado.
 */

type Queryable = Pick<PoolClient, 'query'>

async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>, begin = 'BEGIN'): Promise<T> {
  const client = await pool.connect()
  let discard: Error | undefined
  try {
    await client.query(begin)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    discard = await rollbackOrDiscard(client, error)
    throw error
  } finally {
    client.release(discard)
  }
}

function stamp(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return (value instanceof Date ? value : new Date(String(value))).toISOString()
}

function text(value: string | null): string | null {
  return value === null ? null : decodePostgresText(value)
}

function decodeEnvioRow(row: HandoffEnvioRow): HandoffEnvioRow {
  return {
    ...row,
    plan_titulo: decodePostgresText(row.plan_titulo),
    conversation_title: decodePostgresText(row.conversation_title),
    conteudo: decodePostgresText(row.conteudo),
    motivo: text(row.motivo),
    criado_em: stamp(row.criado_em) ?? new Date(0).toISOString(),
    enviado_em: stamp(row.enviado_em),
    iniciado_em: stamp(row.iniciado_em),
    concluido_em: stamp(row.concluido_em),
    updated_at: stamp(row.updated_at) ?? new Date(0).toISOString()
  }
}

function decodeEntregaRow(row: HandoffEntregaRow): HandoffEntregaRow {
  return {
    ...row,
    etapa_titulo: decodePostgresText(row.etapa_titulo),
    estimativa_agente_motivo: text(row.estimativa_agente_motivo),
    motivo: text(row.motivo),
    estimativa_agente_em: stamp(row.estimativa_agente_em),
    corrigido_em: stamp(row.corrigido_em),
    iniciada_em: stamp(row.iniciada_em),
    concluida_em: stamp(row.concluida_em),
    aviso_80_em: stamp(row.aviso_80_em),
    aviso_100_em: stamp(row.aviso_100_em),
    updated_at: stamp(row.updated_at) ?? new Date(0).toISOString()
  }
}

/** Os envios pedidos, com as entregas, na ordem do SELECT. `where` usa
 *  `$1..$n` de `params`; o limite entra como o parâmetro seguinte. */
async function loadEnvios(client: Queryable, where: string, params: unknown[], limit: number): Promise<HandoffEnvio[]> {
  const envios = await client.query<HandoffEnvioRow>(
    `SELECT ${HANDOFF_ENVIO_COLUMNS} FROM handoff_envios ${where}
     ORDER BY criado_em DESC, ordem ASC, id ASC LIMIT $${params.length + 1}`,
    [...params, limit]
  )
  if (envios.rows.length === 0) return []
  const entregas = await client.query<HandoffEntregaRow>(
    `SELECT ${HANDOFF_ENTREGA_COLUMNS} FROM handoff_entregas
     WHERE envio_id = ANY($1::text[]) ORDER BY envio_id, ordem ASC, id ASC`,
    [envios.rows.map((row) => row.id)]
  )
  const decoded = entregas.rows.map((row) => handoffEntregaFromRow(decodeEntregaRow(row)))
  return envios.rows.map((row) =>
    handoffEnvioFromRow(decodeEnvioRow(row), decoded.filter((entrega) => entrega.envioId === row.id))
  )
}

async function loadEnvio(client: Queryable, id: string): Promise<HandoffEnvio> {
  const [envio] = await loadEnvios(client, 'WHERE id = $1', [id], 1)
  if (!envio) throw new TypeError(`Envio de handoff inexistente: ${id}`)
  return envio
}

export async function createPostgresHandoffEnvios(pool: Pool, input: HandoffEnvioCreate[]): Promise<HandoffEnvio[]> {
  if (!Array.isArray(input)) throw new TypeError('createHandoffEnvios espera uma lista.')
  // Valida TUDO antes da transação: um envio inválido não grava nenhum.
  const prepared = input.map(prepareHandoffEnvio)
  if (prepared.length === 0) return []
  return transaction(pool, async (client) => {
    // `now()` é a hora da TRANSAÇÃO: o lote inteiro recebe o mesmo carimbo e a
    // ordem "criado_em DESC, ordem ASC" devolve o lote de 1 a n. Com
    // clock_timestamp() cada envio teria um carimbo maior que o anterior e o
    // lote sairia invertido.
    for (const envio of prepared) {
      await client.query(
        `INSERT INTO handoff_envios(id, plan_slug, plan_titulo, project_id, project_cwd, conversation_id,
           conversation_title, arquivo, ordem, lote_id, conteudo, conteudo_hash, status, estimativa_total,
           prazo_total, criado_em, updated_at)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'na_fila', $13, $14, now(), now())`,
        [
          envio.id,
          envio.planSlug,
          encodePostgresText(envio.planTitulo),
          envio.projectId,
          envio.projectCwd,
          envio.conversationId,
          encodePostgresText(envio.conversationTitle),
          envio.arquivo,
          envio.ordem,
          envio.loteId,
          encodePostgresText(envio.conteudo),
          envio.conteudoHash,
          envio.estimativaTotal,
          envio.prazoTotal
        ]
      )
    }
    // Todas as entregas do lote num INSERT só: com PostgreSQL remoto, uma ida e
    // volta por etapa somaria segundos.
    const entregas = prepared.flatMap((envio) => envio.entregas.map((entrega) => ({ ...entrega, envioId: envio.id })))
    if (entregas.length > 0) {
      await client.query(
        `INSERT INTO handoff_entregas(id, envio_id, etapa_id, etapa_titulo, ordem, estimativa_plano, status, updated_at)
         SELECT e.id, e.envio_id, e.etapa_id, e.etapa_titulo, e.ordem, e.estimativa_plano, 'pendente', now()
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::integer[], $6::integer[])
           AS e(id, envio_id, etapa_id, etapa_titulo, ordem, estimativa_plano)`,
        [
          entregas.map((entrega) => entrega.id),
          entregas.map((entrega) => entrega.envioId),
          entregas.map((entrega) => entrega.etapaId),
          entregas.map((entrega) => encodePostgresText(entrega.etapaTitulo)),
          entregas.map((entrega) => entrega.ordem),
          entregas.map((entrega) => entrega.estimativaPlano)
        ]
      )
    }
    const ids = prepared.map((envio) => envio.id)
    const byId = new Map((await loadEnvios(client, 'WHERE id = ANY($1::text[])', [ids], ids.length)).map((envio) => [envio.id, envio]))
    return ids.map((id) => byId.get(id)!)
  })
}

export async function listPostgresHandoffEnvios(pool: Pool, query: HandoffEnvioQuery): Promise<HandoffEnvio[]> {
  const filter = normalizeHandoffQuery(query)
  if (filter.empty) return []
  const clauses: string[] = []
  const params: unknown[] = []
  if (filter.ids) {
    params.push(filter.ids)
    clauses.push(`id = ANY($${params.length}::text[])`)
  }
  if (filter.conversationId !== undefined) {
    params.push(filter.conversationId)
    clauses.push(`conversation_id = $${params.length}`)
  }
  if (filter.projectIds) {
    params.push(filter.projectIds)
    clauses.push(`project_id = ANY($${params.length}::text[])`)
  }
  if (filter.statuses) {
    params.push(filter.statuses)
    clauses.push(`status = ANY($${params.length}::text[])`)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  // Mesmo snapshot para envios e entregas: uma escrita entre os dois SELECTs
  // não pode devolver um envio com entregas de outro instante.
  return transaction(pool, (client) => loadEnvios(client, where, params, filter.limit), 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
}

/** `SET` com as colunas do patch (texto livre escapado) e `updated_at`. */
function setClause(writes: HandoffColumnWrite[]): { sets: string; values: unknown[] } {
  const values = writes.map((write) =>
    write.text && typeof write.value === 'string' ? encodePostgresText(write.value) : write.value
  )
  const sets = [...writes.map((write, index) => `${write.column} = $${index + 1}`), 'updated_at = clock_timestamp()']
  return { sets: sets.join(', '), values }
}

export async function updatePostgresHandoffEnvio(pool: Pool, id: string, patch: HandoffEnvioPatch): Promise<HandoffEnvio> {
  const { sets, values } = setClause(handoffEnvioPatchWrites(patch))
  return transaction(pool, async (client) => {
    const result = await client.query(`UPDATE handoff_envios SET ${sets} WHERE id = $${values.length + 1}`, [...values, id])
    if (!result.rowCount) throw new TypeError(`Envio de handoff inexistente: ${id}`)
    return loadEnvio(client, id)
  })
}

export async function updatePostgresHandoffEntrega(pool: Pool, id: string, patch: HandoffEntregaPatch): Promise<HandoffEnvio> {
  const { sets, values } = setClause(handoffEntregaPatchWrites(patch))
  return transaction(pool, async (client) => {
    const result = await client.query<{ envio_id: string }>(
      `UPDATE handoff_entregas SET ${sets} WHERE id = $${values.length + 1} RETURNING envio_id`,
      [...values, id]
    )
    if (!result.rows[0]) throw new TypeError(`Entrega de handoff inexistente: ${id}`)
    return loadEnvio(client, result.rows[0].envio_id)
  })
}

/** Recebe o incremento JÁ normalizado (`normalizeHandoffTimeAdd`): soma na
 *  própria linha (`col = col + $n`), então dois PCs somando ao mesmo tempo não
 *  perdem fatia nenhuma. */
export async function addPostgresHandoffTime(pool: Pool, input: NormalizedHandoffTimeAdd): Promise<void> {
  await transaction(pool, async (client) => {
    const envio = await client.query(
      `UPDATE handoff_envios SET tempo_ativo_ms = tempo_ativo_ms + $1, retrabalho_ms = retrabalho_ms + $2,
         updated_at = clock_timestamp()
       WHERE id = $3`,
      [input.ativoMs, input.retrabalhoMs, input.envioId]
    )
    if (!envio.rowCount) throw new TypeError(`Envio de handoff inexistente: ${input.envioId}`)
    for (const item of input.entregas) {
      const entrega = await client.query(
        `UPDATE handoff_entregas SET tempo_ativo_ms = tempo_ativo_ms + $1, retrabalho_ms = retrabalho_ms + $2,
           updated_at = clock_timestamp()
         WHERE id = $3 AND envio_id = $4`,
        [item.ativoMs, item.retrabalhoMs, item.id, input.envioId]
      )
      if (!entrega.rowCount) throw new TypeError(`Entrega ${item.id} não pertence ao envio ${input.envioId}.`)
    }
  })
}
