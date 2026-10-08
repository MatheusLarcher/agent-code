import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PostgresConnectionDraft } from '../../../shared/ipc'
import { POSTGRES_DATABASE } from '../bootstrapStore'
import { childEnv } from '../localPostgres'
import { StorageError } from '../types'

/**
 * O pg_dump e o pg_restore que vêm com o PostgreSQL embutido (out/postgres no
 * desenvolvimento, resources/postgres instalado), num processo separado: um dump
 * grande nunca roda dentro do main. A conexão vai pelo ambiente (PGPASSWORD,
 * PGSSLMODE…), nunca pela linha de comando.
 */

/** Espera do pg_dump por trava de tabela (outro PC no meio de uma alteração de
 *  esquema): passou disto, o backup falha em vez de esperar para sempre. */
export const PG_DUMP_LOCK_WAIT_MS = 30_000

export interface PgToolResult {
  code: number | null
  /** O fim do stderr (o motivo de uma falha). */
  stderr: string
}

export type PgToolRunner = (file: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<PgToolResult>

export class PgToolAbortedError extends Error {
  constructor() {
    super('Operação cancelada.')
    this.name = 'PgToolAbortedError'
  }
}

export const runPgTool: PgToolRunner = (file, args, env, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new PgToolAbortedError())
    // Sem pipe no stdout: o pg_dump grava no arquivo (-f) e o pg_restore direto no banco.
    const child = spawn(file, args, { windowsHide: true, env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_384)
    })
    const abort = (): void => {
      child.kill()
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', (error) => {
      signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) return reject(new PgToolAbortedError())
      resolve({ code, stderr })
    })
  })

export interface PgToolEnv {
  env: NodeJS.ProcessEnv
  /** Apaga o arquivo temporário da CA (verify-full com CA colada na tela). */
  dispose(): Promise<void>
}

/** O ambiente da conexão: os mesmos campos que o app usa no `pg` (postgresProvisioning.ts). */
export async function pgToolEnv(draft: PostgresConnectionDraft): Promise<PgToolEnv> {
  const env = childEnv()
  env['PGHOST'] = draft.host
  env['PGPORT'] = String(draft.port)
  env['PGUSER'] = draft.user
  env['PGDATABASE'] = POSTGRES_DATABASE
  if (draft.password) env['PGPASSWORD'] = draft.password
  env['PGSSLMODE'] = draft.tlsMode
  env['PGCONNECT_TIMEOUT'] = '15'
  env['PGAPPNAME'] = 'agent-code-backup'
  let caDir: string | null = null
  if (draft.tlsMode === 'verify-full') {
    if (draft.ca.trim()) {
      caDir = await mkdtemp(join(tmpdir(), 'agent-code-pgca-'))
      const file = join(caDir, 'ca.pem')
      await writeFile(file, draft.ca, { encoding: 'utf8', mode: 0o600 })
      env['PGSSLROOTCERT'] = file
    } else {
      // Sem CA colada, o `pg` do app usa as CAs do sistema; a libpq, a mesma coisa assim.
      env['PGSSLROOTCERT'] = 'system'
    }
  }
  return {
    env,
    dispose: async () => {
      if (caDir) await rm(caDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

/** pg_dump comprimido (-Fc) do banco agent-code; `snapshot` = o exportado por quem contou as linhas. */
export function pgDumpArgs(file: string, snapshot?: string): string[] {
  return [
    '--format=custom',
    '--no-password',
    `--lock-wait-timeout=${PG_DUMP_LOCK_WAIT_MS}`,
    ...(snapshot ? [`--snapshot=${snapshot}`] : []),
    `--file=${file}`,
    POSTGRES_DATABASE
  ]
}

/**
 * pg_restore por cima do banco agent-code: `--clean --if-exists` troca cada objeto
 * do arquivo, e `--single-transaction` faz tudo ou nada — uma falha no meio deixa o
 * destino como estava. Sem dono nem permissões do servidor de origem: a cópia vai
 * entre servidores com usuários diferentes (agentcode no local, o da nuvem).
 */
export function pgRestoreArgs(file: string): string[] {
  return [
    '--no-password',
    `--dbname=${POSTGRES_DATABASE}`,
    '--clean',
    '--if-exists',
    '--single-transaction',
    '--no-owner',
    '--no-privileges',
    '--no-publications',
    '--no-subscriptions',
    '--no-security-labels',
    '--no-table-access-method',
    file
  ]
}

/** O motivo de uma saída diferente de 0, para a tela: as linhas de erro do stderr. */
export function pgToolFailure(tool: 'pg_dump' | 'pg_restore', result: PgToolResult): StorageError {
  const lines = result.stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const errors = lines.filter((line) => /error|fatal|erro/i.test(line))
  const reason = [...new Set((errors.length ? errors : lines).slice(-3))].join(' | ')
  return new StorageError(
    'BACKUP_FAILED',
    `${tool} falhou (código ${result.code ?? 'sem código'})${reason ? `: ${reason}` : '.'}`,
    false
  )
}

/** Roda uma ferramenta com o ambiente da conexão e confere a saída. */
export async function runPgToolChecked(
  run: PgToolRunner,
  binDir: string,
  tool: 'pg_dump' | 'pg_restore',
  draft: PostgresConnectionDraft,
  args: string[],
  signal?: AbortSignal
): Promise<void> {
  const { env, dispose } = await pgToolEnv(draft)
  try {
    const result = await run(join(binDir, `${tool}.exe`), args, env, signal)
    if (result.code !== 0) throw pgToolFailure(tool, result)
  } finally {
    await dispose()
  }
}
