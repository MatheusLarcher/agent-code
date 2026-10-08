import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  BACKUP_REASONS,
  BACKUPS_PER_REASON,
  type BackupReason,
  type DatabaseBackupDto,
  type DatabaseSide
} from '../../../shared/databaseBackup'
import { StorageError } from '../types'

/**
 * A pasta de backups (`<pasta de dados>\backups`, no OneDrive nesta máquina): um
 * `.dump` (pg_dump -Fc) e um `.json` ao lado para cada backup. O `.json` é gravado
 * por último — sem ele o backup não está completo e não aparece na lista. Um dump
 * interrompido (app fechado no meio) só deixa `.partial`, apagado na próxima vez.
 */

const metaSchema = z.object({
  version: z.literal(1),
  file: z.string(),
  createdAt: z.string(),
  side: z.enum(['local', 'nuvem']),
  reason: z.enum(BACKUP_REASONS as [BackupReason, ...BackupReason[]]),
  appVersion: z.string(),
  conversations: z.number().int().min(0),
  lastUpdate: z.string().nullable(),
  sizeBytes: z.number().int().min(0),
  /** Linhas por tabela no snapshot do dump: a restauração confere por elas. */
  tables: z.record(z.string(), z.number().int().min(0)),
  serverVersion: z.string().nullable(),
  durationMs: z.number().int().min(0).optional()
})

export type BackupMeta = z.infer<typeof metaSchema>

const NAME = /^(\d{4}-\d{2}-\d{2})_(\d{4})_(local|nuvem)_(diario|antes-da-troca|antes-da-restauracao)(?:-(\d{1,3}))?\.dump$/

const pad = (value: number): string => String(value).padStart(2, '0')

/** `2026-10-08_0012_nuvem_antes-da-troca` (hora local, como o usuário lê). */
export function backupBaseName(date: Date, side: DatabaseSide, reason: BackupReason): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${day}_${pad(date.getHours())}${pad(date.getMinutes())}_${side}_${reason}`
}

/** O nome livre na pasta: dois backups no mesmo minuto ganham `-2`, `-3`… */
export function uniqueBackupFile(dir: string, date: Date, side: DatabaseSide, reason: BackupReason): string {
  const base = backupBaseName(date, side, reason)
  for (let attempt = 1; attempt < 1000; attempt++) {
    const name = attempt === 1 ? base : `${base}-${attempt}`
    if (!existsSync(join(dir, `${name}.dump`)) && !existsSync(join(dir, `${name}.json`))) return `${name}.dump`
  }
  throw new StorageError('BACKUP_FAILED', 'Não há nome livre para o backup na pasta.')
}

export function isBackupFileName(file: string): boolean {
  return NAME.test(file)
}

const metaPath = (dir: string, file: string): string => join(dir, file.replace(/\.dump$/, '.json'))

/** Caminho de um backup da lista; nome fora do padrão é recusado (nada de `..\`). */
export function backupPath(dir: string, file: string): string {
  if (!isBackupFileName(file)) throw new StorageError('INVALID_PERSISTED_DATA', 'Nome de backup inválido.')
  return join(dir, file)
}

export async function readBackupMeta(dir: string, file: string): Promise<BackupMeta> {
  backupPath(dir, file)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(metaPath(dir, file), 'utf8'))
  } catch (cause) {
    throw new StorageError('INVALID_PERSISTED_DATA', `O backup ${file} não tem os dados ao lado (.json).`, false, { cause })
  }
  const checked = metaSchema.safeParse(parsed)
  if (!checked.success || checked.data.file !== file) {
    throw new StorageError('INVALID_PERSISTED_DATA', `Os dados do backup ${file} estão inválidos.`)
  }
  if (!existsSync(join(dir, file))) throw new StorageError('INVALID_PERSISTED_DATA', `O arquivo ${file} não está mais na pasta.`)
  return checked.data
}

export function toBackupDto(meta: BackupMeta): DatabaseBackupDto {
  return {
    file: meta.file,
    createdAt: meta.createdAt,
    side: meta.side,
    reason: meta.reason,
    appVersion: meta.appVersion,
    conversations: meta.conversations,
    lastUpdate: meta.lastUpdate,
    sizeBytes: meta.sizeBytes
  }
}

/** Os backups completos, do mais novo para o mais antigo, e o peso da pasta inteira. */
export async function listBackups(dir: string): Promise<{ items: BackupMeta[]; totalBytes: number }> {
  const names = await readdir(dir).catch(() => [] as string[])
  let totalBytes = 0
  for (const name of names) totalBytes += (await stat(join(dir, name)).catch(() => null))?.size ?? 0
  const items: BackupMeta[] = []
  for (const name of names) {
    if (!isBackupFileName(name)) continue
    const meta = await readBackupMeta(dir, name).catch(() => null)
    if (meta) items.push(meta)
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.file.localeCompare(a.file))
  return { items, totalBytes }
}

/** Leva o dump pronto (pasta local) para a de backups e grava o .json por último. */
export async function commitBackup(dir: string, tempDump: string, meta: BackupMeta): Promise<void> {
  await mkdir(dir, { recursive: true })
  const target = backupPath(dir, meta.file)
  const partial = `${target}.partial`
  try {
    await rename(tempDump, partial).catch(async (error: NodeJS.ErrnoException) => {
      // Outro disco (a pasta de dados no OneDrive em D:, o temporário em C:).
      if (error.code !== 'EXDEV') throw error
      await copyFile(tempDump, partial)
    })
    await rename(partial, target)
    const jsonTemp = `${metaPath(dir, meta.file)}.tmp-${process.pid}`
    await writeFile(jsonTemp, JSON.stringify(metaSchema.parse(meta), null, 2), 'utf8')
    await rename(jsonTemp, metaPath(dir, meta.file))
  } catch (cause) {
    await rm(partial, { force: true }).catch(() => undefined)
    await rm(target, { force: true }).catch(() => undefined)
    throw new StorageError('BACKUP_FAILED', 'Não foi possível gravar o backup na pasta de dados.', false, { cause })
  }
}

export async function deleteBackup(dir: string, file: string): Promise<void> {
  const path = backupPath(dir, file)
  await rm(metaPath(dir, file), { force: true })
  await rm(path, { force: true })
}

/** Retenção: no máximo `max` por motivo (os diários não empurram os de antes de uma troca). */
export async function pruneBackups(dir: string, reason: BackupReason, max = BACKUPS_PER_REASON): Promise<string[]> {
  const { items } = await listBackups(dir)
  const removed: string[] = []
  for (const meta of items.filter((item) => item.reason === reason).slice(max)) {
    await deleteBackup(dir, meta.file).catch(() => undefined)
    removed.push(meta.file)
  }
  return removed
}

/** Sobras de um backup interrompido: `.partial` e `.json` temporário. */
export async function removePartials(dir: string): Promise<number> {
  let removed = 0
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!/\.dump\.partial$|\.json\.tmp-\d+$/.test(name)) continue
    await rm(join(dir, name), { force: true }).catch(() => undefined)
    removed++
  }
  return removed
}
