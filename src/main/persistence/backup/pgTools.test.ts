// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import type { PostgresConnectionDraft } from '../../../shared/ipc'
import { pgDumpArgs, pgRestoreArgs, pgToolEnv, pgToolFailure } from './pgTools'

const draft: PostgresConnectionDraft = {
  host: 'db.exemplo',
  port: 6502,
  user: 'app',
  password: 'segredo',
  maintenanceDatabase: 'postgres',
  tlsMode: 'disable',
  ca: ''
}

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

describe('pg_dump/pg_restore', () => {
  it('dump comprimido no snapshot de quem contou; restore tudo-ou-nada, sem dono nem permissões', () => {
    expect(pgDumpArgs('C:/t/a.dump', '00000003-1')).toEqual([
      '--format=custom',
      '--no-password',
      '--lock-wait-timeout=30000',
      '--snapshot=00000003-1',
      '--file=C:/t/a.dump',
      'agent-code'
    ])
    const restore = pgRestoreArgs('C:/t/a.dump')
    for (const flag of ['--clean', '--if-exists', '--single-transaction', '--no-owner', '--no-privileges', '--no-password']) {
      expect(restore).toContain(flag)
    }
    expect(restore).toContain('--dbname=agent-code')
    expect(restore.at(-1)).toBe('C:/t/a.dump')
  })

  it('a conexão vai pelo ambiente — senha fora da linha de comando — e o PG* do usuário não vaza', async () => {
    process.env.PGHOST = 'outro-servidor'
    process.env.PGSSLROOTCERT = 'C:/qualquer.crt'
    const { env, dispose } = await pgToolEnv(draft)
    expect(env).toMatchObject({ PGHOST: 'db.exemplo', PGPORT: '6502', PGUSER: 'app', PGPASSWORD: 'segredo', PGDATABASE: 'agent-code', PGSSLMODE: 'disable' })
    expect(env.PGSSLROOTCERT).toBeUndefined()
    expect(pgDumpArgs('x').join(' ')).not.toContain('segredo')
    await dispose()
  })

  it('verify-full com CA colada: arquivo temporário apagado depois; sem CA, as do sistema', async () => {
    const withCa = await pgToolEnv({ ...draft, tlsMode: 'verify-full', ca: '-----BEGIN CERTIFICATE-----\nabc' })
    const file = withCa.env.PGSSLROOTCERT as string
    expect(readFileSync(file, 'utf8')).toContain('BEGIN CERTIFICATE')
    await withCa.dispose()
    expect(existsSync(file)).toBe(false)
    expect((await pgToolEnv({ ...draft, tlsMode: 'verify-full' })).env.PGSSLROOTCERT).toBe('system')
  })

  it('a falha diz o motivo do stderr', () => {
    const error = pgToolFailure('pg_restore', {
      code: 1,
      stderr: 'pg_restore: connecting to database\npg_restore: error: could not execute query: ERROR:  unrecognized configuration parameter "transaction_timeout"\n'
    })
    expect(error.code).toBe('BACKUP_FAILED')
    expect(error.message).toMatch(/^pg_restore falhou \(código 1\): .*transaction_timeout/)
  })
})
