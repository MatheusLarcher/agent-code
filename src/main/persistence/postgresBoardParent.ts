import type { Pool } from 'pg'

/**
 * O vínculo da pendência no PostgreSQL COMPARTILHADO: a coluna
 * `board_items.parent_id`, SEM migração numerada.
 *
 * Uma migração numerada nova faria `applyPostgresMigrations` de uma versão mais
 * velha do app — rodando no outro PC — recusar o banco inteiro na próxima
 * abertura (`SCHEMA_TOO_NEW`). A coluna é aditiva e aceita nulo, então a versão
 * velha não precisa saber dela: as escritas dela listam as colunas que conhece,
 * e o cartão que ela cria fica sem pai. Aqui a coluna é garantida na abertura
 * (o `ALTER` só roda quando ela falta, com teto de espera pelo lock, para não
 * segurar a tabela que o outro PC está usando) e o repositório só a lê quando
 * ela existe — sem ela, o quadro funciona como antes, só sem o vínculo.
 */

/** Teto da espera pelo lock do `ALTER TABLE`: o outro PC pode estar escrevendo
 *  no quadro, e a abertura do app não pode ficar presa nisso. */
const LOCK_TIMEOUT_MS = 5_000

const HAS_COLUMN = `
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'board_items' AND column_name = 'parent_id'
`

async function hasColumn(pool: Pool): Promise<boolean> {
  const result = await pool.query(HAS_COLUMN)
  return (result.rowCount ?? 0) > 0
}

/** `true` quando a coluna existe (já existia ou acabou de ser criada). Nunca
 *  lança: sem a coluna, o quadro segue sem o vínculo. */
export async function ensurePostgresBoardParent(pool: Pool): Promise<boolean> {
  try {
    if (await hasColumn(pool)) return true
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`)
      await client.query('ALTER TABLE board_items ADD COLUMN IF NOT EXISTS parent_id text')
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    return await hasColumn(pool)
  } catch (error) {
    console.warn(`[quadro] vínculo das pendências indisponível no PostgreSQL: ${(error as Error)?.message ?? error}`)
    return false
  }
}
