import type { Pool } from 'pg'

/**
 * As colunas ADITIVAS do quadro no PostgreSQL COMPARTILHADO — o vínculo da
 * pendência (`board_items.parent_id`) e o que o usuário precisa fazer
 * (`board_items.po_user_action`) —, SEM migração numerada.
 *
 * Uma migração numerada nova faria `applyPostgresMigrations` de uma versão mais
 * velha do app — rodando no outro PC — recusar o banco inteiro na próxima
 * abertura (`SCHEMA_TOO_NEW`). As colunas são aditivas e aceitam nulo, então a
 * versão velha não precisa saber delas: as escritas dela listam as colunas que
 * conhece, e o cartão que ela cria fica sem pai e sem ação. Aqui cada coluna é
 * garantida na abertura (o `ALTER` só roda quando ela falta, com teto de espera
 * pelo lock, para não segurar a tabela que o outro PC está usando) e o
 * repositório só a lê quando ela existe — sem ela, o quadro funciona como antes,
 * só sem aquele campo.
 */

/** Teto da espera pelo lock do `ALTER TABLE`: o outro PC pode estar escrevendo
 *  no quadro, e a abertura do app não pode ficar presa nisso. */
const LOCK_TIMEOUT_MS = 5_000

/** As colunas que este arquivo sabe garantir. Lista fechada: o nome entra no
 *  `ALTER` como texto, nunca vem de fora. */
type BoardAdditiveColumn = 'parent_id' | 'po_user_action'

const HAS_COLUMN = `
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'board_items' AND column_name = $1
`

async function hasColumn(pool: Pool, column: BoardAdditiveColumn): Promise<boolean> {
  const result = await pool.query(HAS_COLUMN, [column])
  return (result.rowCount ?? 0) > 0
}

/** `true` quando a coluna existe (já existia ou acabou de ser criada). Nunca
 *  lança: sem a coluna, o quadro segue sem aquele campo. */
async function ensureBoardColumn(pool: Pool, column: BoardAdditiveColumn, what: string): Promise<boolean> {
  try {
    if (await hasColumn(pool, column)) return true
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`)
      await client.query(`ALTER TABLE board_items ADD COLUMN IF NOT EXISTS ${column} text`)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    return await hasColumn(pool, column)
  } catch (error) {
    console.warn(`[quadro] ${what} indisponível no PostgreSQL: ${(error as Error)?.message ?? error}`)
    return false
  }
}

export function ensurePostgresBoardParent(pool: Pool): Promise<boolean> {
  return ensureBoardColumn(pool, 'parent_id', 'vínculo das pendências')
}

export function ensurePostgresBoardUserAction(pool: Pool): Promise<boolean> {
  return ensureBoardColumn(pool, 'po_user_action', 'campo "O que você precisa fazer"')
}
