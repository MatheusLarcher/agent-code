import type { Pool } from 'pg'
import type { Tarefa, TarefaRodada } from '../../shared/tarefas'
import { decodePostgresText, encodePostgresText } from './postgresEncoding'
import { msOf, rodadaFromRow, tarefaFromRow, ultimasPorTarefa } from './tarefaRows'
import type { TarefaClaim, TarefaEstadoPatch, TarefaFimRodada, TarefaRegistro } from './tarefaTypes'

/**
 * As tarefas agendadas no PostgreSQL COMPARTILHADO entre os PCs: `tarefas` e
 * `tarefa_rodadas`, SEM migração numerada — pelo mesmo motivo dos prints dos
 * cartões (postgresBoardPrints.ts): uma migração 19 faria a versão mais velha do
 * app, no outro PC, recusar o banco inteiro (`SCHEMA_TOO_NEW`). As tabelas são
 * novas e só o app novo as lê. Garantidas na abertura, com teto de espera pelo lock.
 */

const LOCK_TIMEOUT_MS = 5_000

const CREATE = `
  CREATE TABLE IF NOT EXISTS tarefas (
    id text PRIMARY KEY,
    tipo text NOT NULL CHECK(tipo IN ('lembrete', 'monitor')),
    titulo text NOT NULL,
    mensagem text,
    conv_id text NOT NULL,
    cwd text NOT NULL,
    agenda_json text NOT NULL,
    estado text NOT NULL CHECK(estado IN ('ativa', 'pausada', 'concluida', 'cancelada')),
    modelo text,
    condicao text,
    combinado text,
    criada_por text NOT NULL,
    criada_em timestamptz NOT NULL,
    atualizada_em timestamptz NOT NULL,
    proxima_ms bigint,
    ultima_ms bigint,
    ultimo_resultado text,
    ultimo_valor text,
    avisado_valor text,
    falhas_seguidas integer NOT NULL DEFAULT 0,
    bateu_nao_visto_em timestamptz,
    lease_dono text,
    lease_token text,
    lease_ate bigint
  );
  CREATE INDEX IF NOT EXISTS tarefas_estado ON tarefas(estado, proxima_ms);
  CREATE INDEX IF NOT EXISTS tarefas_conv ON tarefas(conv_id);
  CREATE TABLE IF NOT EXISTS tarefa_rodadas (
    id text PRIMARY KEY,
    tarefa_id text NOT NULL,
    inicio timestamptz NOT NULL,
    fim timestamptz,
    resultado text NOT NULL,
    valor text,
    resumo text,
    fonte text,
    falha text,
    instalacao text
  );
  CREATE INDEX IF NOT EXISTS tarefa_rodadas_tarefa ON tarefa_rodadas(tarefa_id, inicio);
`

const HAS_TABLES = `
  SELECT count(*)::int AS n FROM information_schema.tables
  WHERE table_schema = current_schema() AND table_name IN ('tarefas', 'tarefa_rodadas')
`

async function hasTables(pool: Pool): Promise<boolean> {
  const result = await pool.query(HAS_TABLES)
  return Number((result.rows[0] as { n?: number } | undefined)?.n ?? 0) === 2
}

/** `true` quando as tabelas existem (já existiam ou acabaram de ser criadas). Nunca lança. */
export async function ensurePostgresTarefas(pool: Pool): Promise<boolean> {
  try {
    if (await hasTables(pool)) return true
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`)
      await client.query(CREATE)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    return await hasTables(pool)
  } catch (error) {
    console.warn(`[tarefas] tarefas agendadas indisponíveis no PostgreSQL: ${(error as Error)?.message ?? error}`)
    return false
  }
}

const enc = (value: string | null): string | null => (value === null ? null : encodePostgresText(value))

export async function listPostgresTarefas(pool: Pool): Promise<TarefaRegistro[]> {
  const result = await pool.query(`SELECT * FROM tarefas WHERE estado IN ('ativa', 'pausada') ORDER BY criada_em, id`)
  return (result.rows as Record<string, unknown>[]).map((row) => tarefaFromRow(row, decodePostgresText)).filter((t): t is TarefaRegistro => t !== null)
}

export async function listPostgresTarefaRodadas(pool: Pool, ids: string[], porTarefa: number): Promise<TarefaRodada[]> {
  if (!ids.length || porTarefa <= 0) return []
  const result = await pool.query(`SELECT * FROM tarefa_rodadas WHERE tarefa_id = ANY($1::text[]) ORDER BY inicio DESC, id DESC`, [ids])
  return ultimasPorTarefa((result.rows as Record<string, unknown>[]).map((row) => rodadaFromRow(row, decodePostgresText)), porTarefa)
}

export async function insertPostgresTarefa(pool: Pool, t: Tarefa): Promise<void> {
  await pool.query(
    `INSERT INTO tarefas (id, tipo, titulo, mensagem, conv_id, cwd, agenda_json, estado, modelo, condicao, combinado, criada_por,
       criada_em, atualizada_em, proxima_ms, ultima_ms, ultimo_resultado, ultimo_valor, avisado_valor, falhas_seguidas, bateu_nao_visto_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (id) DO NOTHING`,
    [
      t.id, t.tipo, encodePostgresText(t.titulo), enc(t.mensagem), t.convId, encodePostgresText(t.cwd), encodePostgresText(JSON.stringify(t.agenda)),
      t.estado, enc(t.modelo), enc(t.condicao), enc(t.combinado), t.criadaPor, t.criadaEm, t.atualizadaEm, msOf(t.proximaEm), msOf(t.ultimaEm),
      t.ultimoResultado, enc(t.ultimoValor), enc(t.avisadoValor), t.falhasSeguidas, t.bateuNaoVistoEm
    ]
  )
}

export async function updatePostgresTarefaEstado(pool: Pool, patch: TarefaEstadoPatch): Promise<boolean> {
  const result = await pool.query(
    `UPDATE tarefas SET estado = $1::text, proxima_ms = $2::bigint, atualizada_em = $3::timestamptz,
       falhas_seguidas = CASE WHEN $1::text = 'ativa' THEN 0 ELSE falhas_seguidas END
     WHERE id = $4`,
    [patch.estado, msOf(patch.proximaEm), patch.atualizadaEm, patch.id]
  )
  return (result.rowCount ?? 0) > 0
}

export async function marcarPostgresTarefaVista(pool: Pool, id: string, atualizadaEm: string): Promise<void> {
  await pool.query(`UPDATE tarefas SET bateu_nao_visto_em = NULL, atualizada_em = $1 WHERE id = $2 AND bateu_nao_visto_em IS NOT NULL`, [atualizadaEm, id])
}

export async function cancelPostgresTarefasDaConversa(pool: Pool, convId: string, atualizadaEm: string): Promise<number> {
  const result = await pool.query(
    `UPDATE tarefas SET estado = 'cancelada', proxima_ms = NULL, atualizada_em = $1 WHERE conv_id = $2 AND estado IN ('ativa', 'pausada')`,
    [atualizadaEm, convId]
  )
  return result.rowCount ?? 0
}

export async function claimPostgresTarefa(pool: Pool, c: TarefaClaim): Promise<boolean> {
  const result = await pool.query(
    `UPDATE tarefas SET lease_dono = $1::text, lease_token = $2, lease_ate = $3::bigint
     WHERE id = $4 AND estado = 'ativa' AND proxima_ms IS NOT NULL
       AND proxima_ms <= $5::bigint - (CASE WHEN criada_por = $1::text THEN 0::bigint ELSE $6::bigint END)
       AND (lease_token IS NULL OR lease_ate IS NULL OR lease_ate < $5::bigint OR lease_dono = $1::text)`,
    [c.dono, c.token, c.agora + c.ttlMs, c.id, c.agora, c.cortesiaMs]
  )
  return (result.rowCount ?? 0) > 0
}

export async function renewPostgresTarefaLease(pool: Pool, id: string, token: string, ate: number): Promise<boolean> {
  const result = await pool.query(`UPDATE tarefas SET lease_ate = $1::bigint WHERE id = $2 AND lease_token = $3`, [ate, id, token])
  return (result.rowCount ?? 0) > 0
}

export async function releasePostgresTarefaLease(pool: Pool, id: string, token: string): Promise<void> {
  await pool.query(`UPDATE tarefas SET lease_dono = NULL, lease_token = NULL, lease_ate = NULL WHERE id = $1 AND lease_token = $2`, [id, token])
}

export async function finishPostgresTarefaRodada(pool: Pool, fim: TarefaFimRodada): Promise<boolean> {
  const c = fim.campos
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const updated = await client.query(
      `UPDATE tarefas SET proxima_ms = $1::bigint, ultima_ms = $2::bigint, ultimo_resultado = $3, ultimo_valor = $4, avisado_valor = $5,
         falhas_seguidas = $6, bateu_nao_visto_em = $7::timestamptz,
         estado = CASE WHEN $8::boolean AND estado = 'ativa' THEN 'concluida' ELSE estado END,
         atualizada_em = $9::timestamptz, lease_dono = NULL, lease_token = NULL, lease_ate = NULL
       WHERE id = $10 AND (lease_token = $11
         OR ((lease_token IS NULL OR lease_ate < $12::bigint) AND (ultima_ms IS NULL OR ultima_ms < $13::bigint)))`,
      [
        msOf(c.proximaEm), msOf(c.ultimaEm), c.ultimoResultado, enc(c.ultimoValor), enc(c.avisadoValor), c.falhasSeguidas,
        c.bateuNaoVistoEm, c.concluir, c.atualizadaEm, fim.id, fim.token, fim.agora, fim.inicio
      ]
    )
    if ((updated.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK')
      return false
    }
    for (const r of fim.rodadas) {
      await client.query(
        `INSERT INTO tarefa_rodadas (id, tarefa_id, inicio, fim, resultado, valor, resumo, fonte, falha, instalacao)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.tarefaId, r.inicio, r.fim, r.resultado, enc(r.valor), enc(r.resumo), enc(r.fonte), enc(r.falha), r.instalacao]
      )
    }
    await client.query(
      `DELETE FROM tarefa_rodadas WHERE tarefa_id = $1 AND id NOT IN (
         SELECT id FROM tarefa_rodadas WHERE tarefa_id = $1 ORDER BY inicio DESC, id DESC LIMIT $2)`,
      [fim.id, Math.max(1, fim.guardar)]
    )
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
