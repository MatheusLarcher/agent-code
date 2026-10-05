import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { HandoffEnvio } from '../../shared/handoffTracking'
import {
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
import { decodeSqliteRecordRow, sqliteRecordSelectColumns } from './transferRecords'
import type { HandoffEntregaPatch, HandoffEnvioCreate, HandoffEnvioPatch, HandoffEnvioQuery } from './types'

/**
 * Registro dos envios de handoff no SQLite (migration 15). As funções recebem o
 * `db` já aberto pelo `SqliteRepository` (`read`/`write`), que só delega para
 * cá: cada `write()` é uma cópia atômica do arquivo, então o que roda numa
 * chamada entra junto ou não entra.
 *
 * A leitura usa as mesmas expressões da transferência (`CAST(texto AS BLOB)`):
 * o node:sqlite corta TEXT no primeiro NUL, e o conteúdo do prompt é texto livre.
 */

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function sqliteValue(write: HandoffColumnWrite): SQLInputValue {
  return typeof write.value === 'boolean' ? (write.value ? 1 : 0) : write.value
}

/** Os envios pedidos, com as entregas, na ordem do SELECT. */
function loadEnvios(db: DatabaseSync, where: string, params: SQLInputValue[], limit: number): HandoffEnvio[] {
  const envios = db
    .prepare(
      `SELECT ${sqliteRecordSelectColumns('handoff_envios')} FROM handoff_envios ${where}
       ORDER BY criado_em DESC, ordem ASC, id ASC LIMIT ?`
    )
    .all(...params, limit)
    .map((row) => decodeSqliteRecordRow(row) as unknown as HandoffEnvioRow)
  if (envios.length === 0) return []
  const ids = envios.map((row) => row.id)
  const entregas = db
    .prepare(
      `SELECT ${sqliteRecordSelectColumns('handoff_entregas')} FROM handoff_entregas
       WHERE envio_id IN (${placeholders(ids.length)}) ORDER BY envio_id, ordem ASC, id ASC`
    )
    .all(...ids)
    .map((row) => handoffEntregaFromRow(decodeSqliteRecordRow(row) as unknown as HandoffEntregaRow))
  return envios.map((row) => handoffEnvioFromRow(row, entregas.filter((entrega) => entrega.envioId === row.id)))
}

function loadEnvio(db: DatabaseSync, id: string): HandoffEnvio {
  const [envio] = loadEnvios(db, 'WHERE id = ?', [id], 1)
  if (!envio) throw new TypeError(`Envio de handoff inexistente: ${id}`)
  return envio
}

export function createSqliteHandoffEnvios(db: DatabaseSync, input: HandoffEnvioCreate[]): HandoffEnvio[] {
  if (!Array.isArray(input)) throw new TypeError('createHandoffEnvios espera uma lista.')
  // Valida TUDO antes de abrir a transação: um envio inválido no meio do lote
  // não pode deixar os anteriores gravados.
  const prepared = input.map(prepareHandoffEnvio)
  if (prepared.length === 0) return []
  const now = new Date().toISOString()
  return transaction(db, () => {
    const insertEnvio = db.prepare(
      `INSERT INTO handoff_envios(id, plan_slug, plan_titulo, project_id, project_cwd, conversation_id,
         conversation_title, arquivo, ordem, lote_id, conteudo, conteudo_hash, status, estimativa_total,
         prazo_total, criado_em, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'na_fila', ?, ?, ?, ?)`
    )
    const insertEntrega = db.prepare(
      `INSERT INTO handoff_entregas(id, envio_id, etapa_id, etapa_titulo, ordem, estimativa_plano, status, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, 'pendente', ?)`
    )
    for (const envio of prepared) {
      insertEnvio.run(
        envio.id,
        envio.planSlug,
        envio.planTitulo,
        envio.projectId,
        envio.projectCwd,
        envio.conversationId,
        envio.conversationTitle,
        envio.arquivo,
        envio.ordem,
        envio.loteId,
        envio.conteudo,
        envio.conteudoHash,
        envio.estimativaTotal,
        envio.prazoTotal,
        now,
        now
      )
      for (const entrega of envio.entregas) {
        insertEntrega.run(entrega.id, envio.id, entrega.etapaId, entrega.etapaTitulo, entrega.ordem, entrega.estimativaPlano, now)
      }
    }
    return prepared.map((envio) => loadEnvio(db, envio.id))
  })
}

export function listSqliteHandoffEnvios(db: DatabaseSync, query: HandoffEnvioQuery): HandoffEnvio[] {
  const filter = normalizeHandoffQuery(query)
  if (filter.empty) return []
  const clauses: string[] = []
  const params: SQLInputValue[] = []
  const anyOf = (column: string, values: string[]): void => {
    clauses.push(`${column} IN (${placeholders(values.length)})`)
    params.push(...values)
  }
  if (filter.ids) anyOf('id', filter.ids)
  if (filter.conversationId !== undefined) {
    clauses.push('conversation_id = ?')
    params.push(filter.conversationId)
  }
  if (filter.projectIds) anyOf('project_id', filter.projectIds)
  if (filter.statuses) anyOf('status', filter.statuses)
  return loadEnvios(db, clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params, filter.limit)
}

/** `UPDATE` com as colunas do patch e `updated_at`; devolve quantas linhas mudou. */
function updateRow(db: DatabaseSync, table: string, writes: HandoffColumnWrite[], id: string, now: string): number {
  const sets = [...writes.map((write) => `${write.column} = ?`), 'updated_at = ?']
  const result = db
    .prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`)
    .run(...writes.map(sqliteValue), now, id)
  return Number(result.changes)
}

export function updateSqliteHandoffEnvio(db: DatabaseSync, id: string, patch: HandoffEnvioPatch): HandoffEnvio {
  const writes = handoffEnvioPatchWrites(patch)
  return transaction(db, () => {
    if (updateRow(db, 'handoff_envios', writes, id, new Date().toISOString()) === 0) {
      throw new TypeError(`Envio de handoff inexistente: ${id}`)
    }
    return loadEnvio(db, id)
  })
}

export function updateSqliteHandoffEntrega(db: DatabaseSync, id: string, patch: HandoffEntregaPatch): HandoffEnvio {
  const writes = handoffEntregaPatchWrites(patch)
  return transaction(db, () => {
    if (updateRow(db, 'handoff_entregas', writes, id, new Date().toISOString()) === 0) {
      throw new TypeError(`Entrega de handoff inexistente: ${id}`)
    }
    const row = db.prepare('SELECT envio_id FROM handoff_entregas WHERE id = ?').get(id) as { envio_id: string }
    return loadEnvio(db, row.envio_id)
  })
}

/** Recebe o incremento JÁ normalizado (`normalizeHandoffTimeAdd`): soma na
 *  própria linha (`col = col + ?`), nunca lê-e-regrava. */
export function addSqliteHandoffTime(db: DatabaseSync, input: NormalizedHandoffTimeAdd): void {
  const now = new Date().toISOString()
  transaction(db, () => {
    const envio = db
      .prepare(
        `UPDATE handoff_envios SET tempo_ativo_ms = tempo_ativo_ms + ?, retrabalho_ms = retrabalho_ms + ?, updated_at = ?
         WHERE id = ?`
      )
      .run(input.ativoMs, input.retrabalhoMs, now, input.envioId)
    if (Number(envio.changes) === 0) throw new TypeError(`Envio de handoff inexistente: ${input.envioId}`)
    const entrega = db.prepare(
      `UPDATE handoff_entregas SET tempo_ativo_ms = tempo_ativo_ms + ?, retrabalho_ms = retrabalho_ms + ?, updated_at = ?
       WHERE id = ? AND envio_id = ?`
    )
    for (const item of input.entregas) {
      if (Number(entrega.run(item.ativoMs, item.retrabalhoMs, now, item.id, input.envioId).changes) === 0) {
        throw new TypeError(`Entrega ${item.id} não pertence ao envio ${input.envioId}.`)
      }
    }
  })
}
