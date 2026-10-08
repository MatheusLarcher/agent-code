import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from 'pg'
import type { BackupReason, DatabaseBackupListDto, DatabaseSide } from '../../../shared/databaseBackup'
import type { PostgresConnectionDraft } from '../../../shared/ipc'
import { POSTGRES_DATABASE } from '../bootstrapStore'
import { postgresClientConfig, typedPostgresError } from '../postgresProvisioning'
import { StorageError } from '../types'
import {
  commitBackup,
  deleteBackup,
  listBackups,
  pruneBackups,
  readBackupMeta,
  removePartials,
  toBackupDto,
  uniqueBackupFile,
  type BackupMeta
} from './backupFiles'
import { assertCopyComplete, countDatabase, describeComparison, type DatabaseCounts } from './databaseCounts'
import { PgToolAbortedError, pgDumpArgs, pgRestoreArgs, runPgTool, runPgToolChecked, type PgToolRunner } from './pgTools'
import { DIRECT_RESTORE_MIN_MAJOR, restoreThroughPsql } from './pgRestorePsql'

/**
 * O backup do banco — uma implementação só, usada pelo diário, pela restauração
 * e pela troca local ↔ nuvem. Sempre num processo separado (pg_dump/pg_restore):
 * nunca segura a abertura nem o fechamento; fechar no meio mata o processo e o
 * arquivo pela metade não entra na lista (backupFiles.ts).
 */

/** O diário espera o app abrir e assentar antes de começar. */
export const DAILY_FIRST_DELAY_MS = 45_000
/** Com o app aberto por dias, confere de hora em hora se o diário venceu. */
export const DAILY_RECHECK_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export interface BackupSource {
  side: DatabaseSide
  draft: PostgresConnectionDraft
}

export interface DumpResult {
  counts: DatabaseCounts
  serverVersion: string | null
}

export interface DatabaseBackupsDeps {
  binDir(): string
  /** `<pasta de dados>\backups` (segue a pasta escolhida nas Configurações). */
  backupsDir(): string
  /** Onde o pg_dump escreve antes de o arquivo ir para a pasta de backups (disco local). */
  tempDir(): string
  appVersion: string
  /** O lado em uso, para o diário; null sem PostgreSQL pronto ou durante uma troca. */
  activeSource(): Promise<BackupSource | null>
  /** Para a lista: o lado em uso e se a nuvem está ligada. */
  sides(): Promise<{ activeSide: DatabaseSide | null; cloudEnabled: boolean }>
  log(line: string): void
  /** A lista mudou: backup começou, terminou ou foi apagado. */
  changed(): void
  run?: PgToolRunner
  now?: () => number
}

const mb = (bytes: number): string => (bytes / 1048576).toFixed(1)

/** Conta as linhas e roda o pg_dump no MESMO snapshot: a conferência depois da cópia é exata. */
export async function dumpWithCounts(
  run: PgToolRunner,
  binDir: string,
  draft: PostgresConnectionDraft,
  file: string,
  signal?: AbortSignal
): Promise<DumpResult> {
  const client = new Client(postgresClientConfig(draft, POSTGRES_DATABASE))
  try {
    await client.connect()
  } catch (error) {
    throw typedPostgresError(error, 'connect')
  }
  client.on('error', () => undefined)
  let open = false
  try {
    // O pg_dump importa o snapshot logo ao começar; esta transação fica aberta e
    // parada até ele terminar — nenhum teto do servidor pode derrubá-la antes.
    await client.query('SET idle_in_transaction_session_timeout = 0; SET statement_timeout = 0')
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    open = true
    const snapshot = (await client.query<{ id: string }>('SELECT pg_export_snapshot() AS id')).rows[0].id
    const counts = await countDatabase(client)
    const serverVersion = (await client.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0]?.v ?? null
    await runPgToolChecked(run, binDir, 'pg_dump', draft, pgDumpArgs(file, snapshot), signal)
    return { counts, serverVersion }
  } finally {
    if (open) await client.query('ROLLBACK').catch(() => undefined)
    await client.end().catch(() => undefined)
  }
}

export class DatabaseBackups {
  private readonly run: PgToolRunner
  private readonly now: () => number
  /** Fechamento do app: aborta o que estiver rodando (pg_dump/pg_restore morrem). */
  private readonly closing = new AbortController()
  private current: { side: DatabaseSide; reason: BackupReason; startedAt: string } | null = null
  private daily: { controller: AbortController; done: Promise<void> } | null = null
  private dailyTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: DatabaseBackupsDeps) {
    this.run = deps.run ?? runPgTool
    this.now = deps.now ?? Date.now
  }

  /** Backup de um lado para a pasta de backups; devolve os dados gravados no .json. */
  async create(source: BackupSource, reason: BackupReason, signal?: AbortSignal): Promise<BackupMeta> {
    const merged = this.signal(signal)
    const dir = this.deps.backupsDir()
    const tempDir = this.deps.tempDir()
    try {
      await mkdir(dir, { recursive: true })
      await mkdir(tempDir, { recursive: true })
    } catch (cause) {
      throw new StorageError('BACKUP_FAILED', `Não foi possível criar a pasta de backups (${dir}).`, false, { cause })
    }
    await removePartials(dir)
    const started = this.now()
    const createdAt = new Date(started).toISOString()
    const file = uniqueBackupFile(dir, new Date(started), source.side, reason)
    const temp = join(tempDir, file)
    this.current = { side: source.side, reason, startedAt: createdAt }
    this.deps.changed()
    try {
      const { counts, serverVersion } = await dumpWithCounts(this.run, this.deps.binDir(), source.draft, temp, merged)
      if (merged.aborted) throw new PgToolAbortedError()
      const sizeBytes = (await stat(temp)).size
      const meta: BackupMeta = {
        version: 1,
        file,
        createdAt,
        side: source.side,
        reason,
        appVersion: this.deps.appVersion,
        conversations: counts.conversations,
        lastUpdate: counts.lastUpdate,
        sizeBytes,
        tables: counts.tables,
        serverVersion,
        durationMs: this.now() - started
      }
      await commitBackup(dir, temp, meta)
      const removed = await pruneBackups(dir, reason)
      this.deps.log(
        `backup: ${file} — ${mb(sizeBytes)} MB, ${counts.conversations} conversa(s), em ${meta.durationMs} ms` +
          (removed.length ? `; retenção apagou ${removed.join(', ')}` : '')
      )
      return meta
    } finally {
      await rm(temp, { force: true }).catch(() => undefined)
      this.current = null
      this.deps.changed()
    }
  }

  /** O dump do lado mantido na troca: arquivo temporário (não vai para a lista). */
  async dumpForTransfer(source: BackupSource, signal?: AbortSignal): Promise<DumpResult & { file: string }> {
    const tempDir = this.deps.tempDir()
    await mkdir(tempDir, { recursive: true })
    const file = join(tempDir, `troca-${source.side}-${this.now()}.dump`)
    try {
      return { file, ...(await dumpWithCounts(this.run, this.deps.binDir(), source.draft, file, this.signal(signal))) }
    } catch (error) {
      await rm(file, { force: true }).catch(() => undefined)
      throw error
    }
  }

  /** pg_restore por cima do destino (tudo ou nada) e conferência das contagens. */
  async restoreInto(
    archive: string,
    target: PostgresConnectionDraft,
    expected: Record<string, number>,
    signal?: AbortSignal
  ): Promise<string> {
    const client = new Client(postgresClientConfig(target, POSTGRES_DATABASE))
    try {
      await client.connect()
    } catch (error) {
      throw typedPostgresError(error, 'connect')
    }
    client.on('error', () => undefined)
    try {
      // Parada, sem transação aberta: não segura trava nenhuma durante a restauração.
      const versionNum = Number((await client.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0]?.v)
      const major = Number.isFinite(versionNum) ? Math.floor(versionNum / 10_000) : DIRECT_RESTORE_MIN_MAJOR
      const merged = this.signal(signal)
      if (major < DIRECT_RESTORE_MIN_MAJOR) {
        this.deps.log(`restauração: servidor PostgreSQL ${major} (anterior ao 17) — pelo psql, sem o SET transaction_timeout`)
        await restoreThroughPsql(this.deps.binDir(), target, archive, merged)
      } else {
        await runPgToolChecked(this.run, this.deps.binDir(), 'pg_restore', target, pgRestoreArgs(archive), merged)
      }
      return describeComparison(assertCopyComplete(expected, (await countDatabase(client)).tables))
    } finally {
      await client.end().catch(() => undefined)
    }
  }

  /** O backup escolhido na lista (caminho e o que ele contava). */
  async read(file: string): Promise<{ path: string; meta: BackupMeta }> {
    const dir = this.deps.backupsDir()
    const meta = await readBackupMeta(dir, file)
    return { path: join(dir, file), meta }
  }

  async list(): Promise<DatabaseBackupListDto> {
    const dir = this.deps.backupsDir()
    const [{ items, totalBytes }, sides] = await Promise.all([listBackups(dir), this.deps.sides()])
    return { dir, totalBytes, items: items.map(toBackupDto), running: this.current, ...sides }
  }

  async remove(file: string): Promise<void> {
    await deleteBackup(this.deps.backupsDir(), file)
    this.deps.log(`backup: ${file} apagado pela lista`)
    this.deps.changed()
  }

  /** Na abertura e depois de hora em hora: o diário, se o último tiver mais de 24 h. */
  startDaily(firstDelayMs = DAILY_FIRST_DELAY_MS): void {
    if (this.closing.signal.aborted || this.dailyTimer) return
    this.dailyTimer = setTimeout(() => void this.dailyTick(), firstDelayMs)
    this.dailyTimer.unref?.()
  }

  /** Uma troca/restauração vai começar: o diário em curso para (e é refeito depois). */
  async cancelDaily(): Promise<void> {
    const daily = this.daily
    if (!daily) return
    daily.controller.abort()
    await daily.done
  }

  /** Fechamento do app: mata o pg_dump/pg_restore em curso, sem esperar por ele. */
  dispose(): void {
    if (this.dailyTimer) clearTimeout(this.dailyTimer)
    this.dailyTimer = null
    this.closing.abort()
  }

  get running(): boolean {
    return this.current !== null
  }

  private async dailyTick(): Promise<void> {
    try {
      if (!this.daily && (await this.dailyDue())) {
        const source = await this.deps.activeSource()
        if (source) await this.runDaily(source)
      }
    } catch (error) {
      this.deps.log(`backup diário: não deu para conferir (${error instanceof Error ? error.message : String(error)})`)
    } finally {
      this.dailyTimer = null
      if (!this.closing.signal.aborted) {
        this.dailyTimer = setTimeout(() => void this.dailyTick(), DAILY_RECHECK_MS)
        this.dailyTimer.unref?.()
      }
    }
  }

  private async dailyDue(): Promise<boolean> {
    const { items } = await listBackups(this.deps.backupsDir())
    const last = items.find((meta) => meta.reason === 'diario')
    return !last || this.now() - Date.parse(last.createdAt) >= DAY_MS
  }

  private async runDaily(source: BackupSource): Promise<void> {
    const controller = new AbortController()
    const done = this.create(source, 'diario', controller.signal).then(
      () => undefined,
      (error: unknown) => {
        const aborted = error instanceof PgToolAbortedError || controller.signal.aborted || this.closing.signal.aborted
        this.deps.log(
          aborted
            ? 'backup diário: cancelado (troca, restauração ou fechamento); refeito na próxima oportunidade'
            : `backup diário falhou: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    )
    this.daily = { controller, done }
    try {
      await done
    } finally {
      this.daily = null
    }
  }

  private signal(extra?: AbortSignal): AbortSignal {
    return extra ? AbortSignal.any([extra, this.closing.signal]) : this.closing.signal
  }
}
