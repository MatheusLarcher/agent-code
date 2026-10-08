import type { ClientBase } from 'pg'
import { escapeIdentifier } from 'pg'
import { StorageError } from '../types'

/**
 * Contagem das tabelas do banco agent-code: vai no .json de cada backup e é o
 * que a restauração e a troca conferem depois da cópia. Contada no MESMO snapshot
 * do pg_dump (pg_export_snapshot), a conferência é exata mesmo com o banco em uso.
 */
export interface DatabaseCounts {
  /** Linhas por tabela do esquema public. */
  tables: Record<string, number>
  /** Conversas não apagadas. */
  conversations: number
  /** Última atualização de conversa (ISO); null num banco vazio. */
  lastUpdate: string | null
}

export async function countDatabase(client: Pick<ClientBase, 'query'>): Promise<DatabaseCounts> {
  const names = (
    await client.query<{ name: string }>(
      `SELECT c.relname AS name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        ORDER BY c.relname`
    )
  ).rows.map((row) => row.name)
  const tables: Record<string, number> = {}
  if (names.length) {
    // Uma ida ao servidor para todas: na nuvem, cada ida custa a latência inteira.
    const sql = names
      .map((name, index) => `SELECT ${index}::int AS i, count(*)::bigint AS n FROM public.${escapeIdentifier(name)}`)
      .join(' UNION ALL ')
    for (const row of (await client.query<{ i: number; n: string }>(sql)).rows) tables[names[row.i]] = Number(row.n)
  }
  let conversations = 0
  let lastUpdate: string | null = null
  if ('conversations' in tables) {
    const row = (
      await client.query<{ live: string; last: Date | null }>(
        'SELECT count(*) FILTER (WHERE deleted_at IS NULL)::bigint AS live, max(updated_at) AS last FROM conversations'
      )
    ).rows[0]
    conversations = Number(row?.live ?? 0)
    lastUpdate = row?.last ? new Date(row.last).toISOString() : null
  }
  return { tables, conversations, lastUpdate }
}

export interface CountComparison {
  equal: string[]
  /** Linhas a mais no destino: alguém (outro PC na nuvem) gravou depois da cópia. */
  more: string[]
  /** Linhas a menos ou tabela ausente: a cópia não chegou inteira. */
  less: string[]
}

export function compareCounts(expected: Record<string, number>, actual: Record<string, number>): CountComparison {
  const result: CountComparison = { equal: [], more: [], less: [] }
  for (const [table, count] of Object.entries(expected)) {
    const found = actual[table]
    if (found === count) result.equal.push(table)
    else if (found !== undefined && found > count) result.more.push(`${table} (${count} → ${found})`)
    else result.less.push(`${table} (${count} → ${found ?? 'ausente'})`)
  }
  return result
}

/** Falha da conferência: o destino tem menos do que a origem tinha. */
export function assertCopyComplete(expected: Record<string, number>, actual: Record<string, number>): CountComparison {
  const comparison = compareCounts(expected, actual)
  if (comparison.less.length) {
    throw new StorageError(
      'MIGRATION_VERIFICATION_FAILED',
      `A conferência das contagens depois da cópia não bateu: ${comparison.less.slice(0, 5).join(', ')}.`
    )
  }
  return comparison
}

export function describeComparison(comparison: CountComparison): string {
  const total = comparison.equal.length + comparison.more.length + comparison.less.length
  if (!comparison.more.length && !comparison.less.length) return `${total} tabelas conferidas, todas iguais`
  return (
    `${total} tabelas conferidas: ${comparison.equal.length} iguais` +
    (comparison.more.length ? `, ${comparison.more.length} com linhas gravadas depois da cópia (${comparison.more.slice(0, 3).join(', ')})` : '') +
    (comparison.less.length ? `, ${comparison.less.length} com linhas a menos (${comparison.less.slice(0, 3).join(', ')})` : '')
  )
}
