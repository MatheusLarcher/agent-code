import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ParquetReader } from 'parquetjs-lite'
import { dailyParquetPath, exportConversationsParquet } from './conversationParquet'

async function readRows(path: string): Promise<Record<string, unknown>[]> {
  const reader = await ParquetReader.openFile(path)
  const cursor = reader.getCursor()
  const rows: Record<string, unknown>[] = []
  let row: Record<string, unknown> | null
  while ((row = await cursor.next())) rows.push(row)
  await reader.close()
  return rows
}

describe('conversationParquet', () => {
  it('cria snapshot diário válido com conversas e memórias', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'parquet-cache-'))
    const memories = join(cache, 'memories')
    await mkdir(memories, { recursive: true })
    await writeFile(join(memories, 'MEMORY.md'), '# índice', 'utf8')
    await writeFile(join(memories, 'regra.md'), '---\ndescription: regra\n---\n# Regra\n', 'utf8')

    const date = new Date(2026, 7, 25, 12)
    const path = await exportConversationsParquet(cache, [{ id: 'c1', cwd: 'C:/repo', title: 'Teste', messages: [{ role: 'user', content: 'oi' }] }], memories, date)
    expect(path).toBe(dailyParquetPath(cache, date))
    const rows = await readRows(path)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.tipo)).toEqual(['conversa', 'memoria'])
    expect(rows[0].conteudo).toContain('Teste')
    expect(rows[1].caminhoMemoria).toBe('regra.md')
  })

  it('sobrescreve o arquivo do mesmo dia', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'parquet-cache-'))
    const memories = join(cache, 'memories')
    await mkdir(memories, { recursive: true })
    const date = new Date(2026, 7, 25)
    await exportConversationsParquet(cache, [{ id: 'old' }], memories, date)
    await exportConversationsParquet(cache, [{ id: 'new' }], memories, date)
    const rows = await readRows(dailyParquetPath(cache, date))
    expect(rows).toHaveLength(1)
    expect(rows[0].conteudo).toContain('new')
    expect(rows[0].conteudo).not.toContain('old')
  })
})
