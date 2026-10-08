import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import type { PostgresConnectionDraft } from '../../../shared/ipc'
import { POSTGRES_DATABASE } from '../bootstrapStore'
import { PgToolAbortedError, pgToolEnv, pgToolFailure } from './pgTools'

/**
 * Cópia para um servidor da nuvem ANTERIOR ao 17. O pg_restore 18 abre a sessão com
 * `SET transaction_timeout = 0` (parâmetro que só existe do 17 em diante) e o
 * servidor mais antigo recusa a restauração inteira. Aqui o pg_restore gera o SQL
 * (-f -), essa linha sai do cabeçalho e o psql do próprio Postgres embutido aplica o
 * resto — numa transação nossa: o COMMIT só vai depois de o pg_restore terminar bem.
 * Se ele morrer no meio, o psql chega ao fim da entrada com a transação aberta e o
 * servidor desfaz tudo, como no `--single-transaction`.
 */

/** Do 17 em diante o servidor conhece tudo o que o pg_restore 18 emite: restauração direta. */
export const DIRECT_RESTORE_MIN_MAJOR = 17

export function plainRestoreArgs(file: string): string[] {
  return [
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-privileges',
    '--no-publications',
    '--no-subscriptions',
    '--no-security-labels',
    '--no-table-access-method',
    '--file=-',
    file
  ]
}

export function psqlArgs(): string[] {
  return ['--no-psqlrc', '--quiet', '--set=ON_ERROR_STOP=1', `--dbname=${POSTGRES_DATABASE}`, '--file=-']
}

/** Tira do CABEÇALHO do SQL (antes do primeiro comando de verdade) o SET que o
 *  servidor mais antigo não conhece; os dados passam intactos. */
export function dropUnknownSettings(): Transform {
  let head: Buffer[] = []
  let size = 0
  let passing = false
  const release = (push: (chunk: Buffer) => void): void => {
    const text = Buffer.concat(head).toString('latin1')
    const kept = text
      .split('\n')
      .filter((line) => !/^SET transaction_timeout\s*=/.test(line))
      .join('\n')
    head = []
    passing = true
    push(Buffer.from(kept, 'latin1'))
  }
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (passing) return callback(null, chunk)
      head.push(chunk)
      size += chunk.length
      // Com --clean, depois dos SET vêm os DROP; o cabeçalho é ASCII e curto.
      if (size > 1_048_576 || /\n(DROP|CREATE|ALTER|COPY) /.test(Buffer.concat(head).toString('latin1'))) {
        release((piece) => this.push(piece))
      }
      callback()
    },
    flush(callback) {
      if (!passing) release((piece) => this.push(piece))
      callback()
    }
  })
}

export async function restoreThroughPsql(
  binDir: string,
  draft: PostgresConnectionDraft,
  archive: string,
  signal?: AbortSignal
): Promise<void> {
  const { env, dispose } = await pgToolEnv(draft)
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new PgToolAbortedError())
      const restore = spawn(join(binDir, 'pg_restore.exe'), plainRestoreArgs(archive), { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
      const psql = spawn(join(binDir, 'psql.exe'), psqlArgs(), { windowsHide: true, env, stdio: ['pipe', 'ignore', 'pipe'] })
      let restoreErr = ''
      let psqlErr = ''
      restore.stderr.setEncoding('utf8').on('data', (chunk: string) => (restoreErr = (restoreErr + chunk).slice(-16_384)))
      psql.stderr.setEncoding('utf8').on('data', (chunk: string) => (psqlErr = (psqlErr + chunk).slice(-16_384)))
      // psql que morreu antes (ON_ERROR_STOP) fecha a entrada: escrever nela dá EPIPE.
      psql.stdin.on('error', () => undefined)
      restore.stdout.on('error', () => undefined)
      const abort = (): void => {
        restore.kill()
        psql.kill()
      }
      signal?.addEventListener('abort', abort, { once: true })
      const filter = dropUnknownSettings()
      psql.stdin.write('BEGIN;\n')
      restore.stdout.pipe(filter).pipe(psql.stdin, { end: false })
      const restoreDone = new Promise<number | null>((done) => restore.once('close', (code) => done(code)))
      const filterDone = new Promise<void>((done) => {
        filter.once('end', () => done())
        filter.once('error', () => done())
      })
      void Promise.all([restoreDone, filterDone]).then(([code]) => {
        psql.stdin.end(code === 0 && !signal?.aborted ? 'COMMIT;\n' : '')
      })
      let failed = false
      const fail = (error: unknown): void => {
        if (failed) return
        failed = true
        signal?.removeEventListener('abort', abort)
        abort()
        reject(error)
      }
      restore.once('error', fail)
      psql.once('error', fail)
      psql.once('close', (psqlCode) => {
        if (failed) return
        if (psqlCode !== 0) {
          // O psql parou num erro: o pg_restore ficaria preso escrevendo num cano sem leitor.
          failed = true
          signal?.removeEventListener('abort', abort)
          restore.kill()
          return reject(signal?.aborted ? new PgToolAbortedError() : pgToolFailure('pg_restore', { code: psqlCode, stderr: psqlErr || restoreErr }))
        }
        void restoreDone.then((restoreCode) => {
          if (failed) return
          signal?.removeEventListener('abort', abort)
          if (signal?.aborted) return reject(new PgToolAbortedError())
          if (restoreCode !== 0) return reject(pgToolFailure('pg_restore', { code: restoreCode, stderr: restoreErr }))
          resolve()
        })
      })
    })
  } finally {
    await dispose()
  }
}
