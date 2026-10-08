// @vitest-environment node
// Integração real com os binários embutidos (scripts/stage-postgres.mjs): initdb,
// subir, reusar depois de uma queda do app, pid velho depois de uma queda do
// próprio Postgres, porta ocupada e parar. Ligada por AGENT_CODE_LOCAL_PG_BIN;
// sem ela os casos são pulados.
//
//   $env:AGENT_CODE_LOCAL_PG_BIN='out/postgres/bin'; npx vitest run src/main/persistence/localPostgres.live.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from 'pg'
import { BootstrapStore } from './bootstrapStore'
import { defaultDeps, LocalPostgres, type LocalPostgresDeps } from './localPostgres'

const binDir = process.env.AGENT_CODE_LOCAL_PG_BIN ? resolve(process.env.AGENT_CODE_LOCAL_PG_BIN) : ''

const secureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value, 'utf8'),
  decryptString: (value: Buffer) => value.toString('utf8')
}

describe.skipIf(!binDir)('LocalPostgres com os binários embutidos', () => {
  let root: string
  let bootstrap: BootstrapStore
  const paths = () => ({ binDir, dataDir: join(root, 'pgdata'), logFile: join(root, 'postgres.log') })
  const trace: string[] = []
  const at = () => new Date().toISOString().slice(11, 23)
  const deps: LocalPostgresDeps = {
    run: async (file, args, timeout) => {
      const result = await defaultDeps.run(file, args, timeout)
      trace.push(`${at()} ${file.split(/[\\/]/).pop()} ${args[0]} -> ${result.code} ${result.output.trim().slice(0, 120)}`)
      return result
    },
    start: async (file, args, timeout) => {
      trace.push(`${at()} start ${args[args.indexOf('-o') + 1]} ...`)
      const result = await defaultDeps.start(file, args, timeout)
      trace.push(`${at()} start -> ${result.code}`)
      return result
    },
    portFree: async (port) => {
      const free = await defaultDeps.portFree(port)
      trace.push(`${at()} portFree ${port} -> ${free}`)
      return free
    }
  }
  const server = () => new LocalPostgres(paths, deps)
  const pidOf = async (): Promise<number> => Number((await readFile(join(root, 'pgdata', 'postmaster.pid'), 'utf8')).split(/\r?\n/)[0])
  const query = async (draft: Awaited<ReturnType<LocalPostgres['ensure']>>, sql: string): Promise<string> => {
    const client = new Client({ ...draft, database: 'postgres' })
    await client.connect()
    try {
      return Object.values((await client.query(sql)).rows[0] as Record<string, string>)[0]
    } finally {
      await client.end()
    }
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-code-localpg-live-'))
    bootstrap = new BootstrapStore(join(root, 'userData'), secureStorage)
  })

  afterEach(async (context) => {
    if (context.task.result?.state === 'fail') {
      console.log(`[live] chamadas:\n${trace.join('\n')}`)
      console.log(`[live] log do PostgreSQL:\n${await readFile(join(root, 'postgres.log'), 'utf8').catch(() => '(sem log)')}`)
    }
    trace.length = 0
  })

  afterAll(async () => {
    try {
      execFileSync(join(binDir, 'pg_ctl.exe'), ['stop', '-D', join(root, 'pgdata'), '-m', 'immediate', '-w'], { stdio: 'ignore' })
    } catch {
      // Já parado.
    }
    await rm(root, { recursive: true, force: true })
  })

  it('1ª abertura: initdb, sobe no loopback com scram e a senha guardada', async () => {
    const started = Date.now()
    const draft = await server().ensure(bootstrap)
    console.log(`[live] 1ª abertura (initdb + start): ${Date.now() - started} ms`)
    expect(await query(draft, 'SHOW server_version')).toMatch(/^18\.6/)
    expect(await query(draft, 'SHOW listen_addresses')).toBe('127.0.0.1')
    expect(await query(draft, 'SHOW server_encoding')).toBe('UTF8')
    await expect(query({ ...draft, password: 'errada' }, 'SELECT 1')).rejects.toThrow(/password authentication failed/)
    expect(draft.password).toBe(await bootstrap.localPassword())
  }, 240_000)

  it('o app caiu e o servidor ficou de pé: a próxima abertura reusa o mesmo processo', async () => {
    const before = await pidOf()
    const draft = await server().ensure(bootstrap)
    expect(await pidOf()).toBe(before)
    expect(await query(draft, 'SELECT 1')).toBe(1)
  }, 60_000)

  it('o Postgres morreu à força (pid velho): sobe de novo e se recupera', async () => {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(await pidOf())], { stdio: 'ignore' })
    const draft = await server().ensure(bootstrap)
    expect(await query(draft, 'SELECT 1')).toBe(1)
  }, 120_000)

  it('fechar derruba o servidor; porta gravada ocupada na volta: escolhe outra e grava', async () => {
    const running = server()
    const { port } = await running.ensure(bootstrap)
    await running.stop()
    const status = (() => {
      try {
        execFileSync(join(binDir, 'pg_ctl.exe'), ['status', '-D', join(root, 'pgdata')], { stdio: 'ignore' })
        return 0
      } catch (error) {
        return (error as { status: number }).status
      }
    })()
    expect(status).toBe(3)

    const squatter: Server = createServer()
    await new Promise<void>((done) => squatter.listen(port, '127.0.0.1', () => done()))
    try {
      const draft = await server().ensure(bootstrap)
      expect(draft.port).not.toBe(port)
      expect((await bootstrap.load()).local.port).toBe(draft.port)
      expect(await query(draft, 'SELECT 1')).toBe(1)
    } finally {
      await new Promise<void>((done) => squatter.close(() => done()))
    }
  }, 120_000)
})
