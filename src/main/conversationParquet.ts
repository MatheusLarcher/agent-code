import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import parquet from 'parquetjs-lite'
import { listMemoryFiles } from './memoryIndex'
import type { ConversationRecord } from './projectStore'

const { ParquetSchema, ParquetWriter } = parquet

const EXPORT_DIRNAME = 'memorias-longo-praso'

export interface ConversationParquetRow {
  tipo: 'conversa' | 'memoria'
  id: string
  cwd: string
  titulo: string
  criadoEm: string
  atualizadoEm: string
  conteudo: string
  caminhoMemoria: string
  backend: 'sqlite' | 'postgres'
  watermark: string
}

interface ExportSource { backend: 'sqlite' | 'postgres'; watermark: string }

export function dailyParquetPath(cacheDir: string, now = new Date()): string {
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return join(cacheDir, EXPORT_DIRNAME, `conversas_agent-code_${yyyy}-${mm}-${dd}.parquet`)
}

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function dateText(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  return text(value)
}

function conversationRow(record: ConversationRecord, source: ExportSource): ConversationParquetRow {
  return {
    tipo: 'conversa',
    id: text(record.id),
    cwd: text(record.cwd),
    titulo: text(record.title ?? record.name),
    criadoEm: dateText(record.createdAt),
    atualizadoEm: dateText(record.updatedAt),
    conteudo: JSON.stringify(record),
    caminhoMemoria: '',
    ...source
  }
}

function memoryRows(memoryDir: string, source: ExportSource): ConversationParquetRow[] {
  return listMemoryFiles(memoryDir).flatMap((file) => {
    try {
      return [{
        tipo: 'memoria',
        id: '',
        cwd: '',
        titulo: file.title,
        criadoEm: '',
        atualizadoEm: '',
        conteudo: readFileSync(join(memoryDir, ...file.relPath.split('/')), 'utf8'),
        caminhoMemoria: file.relPath,
        ...source
      }]
    } catch {
      return []
    }
  })
}

/** Writes a complete daily snapshot. A failed export never replaces a valid snapshot. */
export async function exportConversationsParquet(
  cacheDir: string,
  conversations: ConversationRecord[],
  memoryDir: string,
  sourceOrNow: ExportSource | Date = { backend: 'sqlite', watermark: 'sqlite:legacy-export' },
  explicitNow?: Date
): Promise<string> {
  const source = sourceOrNow instanceof Date
    ? { backend: 'sqlite' as const, watermark: 'sqlite:legacy-export' }
    : sourceOrNow
  const now = sourceOrNow instanceof Date ? sourceOrNow : (explicitNow ?? new Date())
  const target = dailyParquetPath(cacheDir, now)
  const exportDir = join(cacheDir, EXPORT_DIRNAME)
  mkdirSync(exportDir, { recursive: true })
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`
  const schema = new ParquetSchema({
    tipo: { type: 'UTF8' },
    id: { type: 'UTF8' },
    cwd: { type: 'UTF8' },
    titulo: { type: 'UTF8' },
    criadoEm: { type: 'UTF8' },
    atualizadoEm: { type: 'UTF8' },
    conteudo: { type: 'UTF8' },
    caminhoMemoria: { type: 'UTF8' },
    backend: { type: 'UTF8' },
    watermark: { type: 'UTF8' }
  })
  try {
    const writer = await ParquetWriter.openFile(schema, temp)
    try {
      for (const record of conversations) await writer.appendRow(conversationRow(record, source))
      for (const row of memoryRows(memoryDir, source)) await writer.appendRow(row)
    } finally {
      await writer.close()
    }
    renameSync(temp, target)
    return target
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* best effort */ }
    throw error
  }
}
