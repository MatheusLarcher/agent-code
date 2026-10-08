// @vitest-environment node
// Ciclo de vida do PostgreSQL embutido com initdb/pg_ctl de mentira: o que é
// chamado, em que ordem, e o que fica em disco e no bootstrap.
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BootstrapStore, LOCAL_POSTGRES_PORT, type SecureStorageAdapter } from './bootstrapStore'
import { LocalPostgres, localPostgresPaths, type CommandResult, type LocalPostgresDeps, type LocalPostgresPaths } from './localPostgres'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const secure: SecureStorageAdapter = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
  decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, '')
}

interface Fake {
  calls: Array<{ tool: string; args: string[] }>
  running: number | null
  busy: Set<number>
  startCode: number
  fastStopFails: boolean
  /** Quantas vezes o `pg_ctl status` ainda diz "rodando" depois de o processo morrer. */
  zombieStatus: number
  /** Quantas sondagens do pg_isready ainda dizem "subindo" depois de o pg_ctl dizer "pronto". */
  listenLag: number
  listenProbes: number
  passwordAtInitdb: string | null
}

async function setup(
  options: {
    running?: number | null
    busy?: number[]
    startCode?: number
    fastStopFails?: boolean
    zombieStatus?: number
    listenLag?: number
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'agent-code-localpg-'))
  dirs.push(root)
  const paths: LocalPostgresPaths = { binDir: join(root, 'bin'), dataDir: join(root, 'pgdata'), logFile: join(root, 'postgres.log') }
  const bootstrap = new BootstrapStore(join(root, 'userData'), secure)
  const fake: Fake = {
    calls: [],
    running: options.running ?? null,
    busy: new Set(options.busy ?? []),
    startCode: options.startCode ?? 0,
    fastStopFails: options.fastStopFails ?? false,
    zombieStatus: options.zombieStatus ?? 0,
    listenLag: options.listenLag ?? 0,
    listenProbes: 0,
    passwordAtInitdb: null
  }
  const tool = (file: string): string => file.split(/[\\/]/).pop()!.replace(/\.exe$/, '')
  const deps: LocalPostgresDeps = {
    run: async (file, args): Promise<CommandResult> => {
      if (tool(file) === 'pg_isready') {
        fake.listenProbes++
        if (fake.listenLag > 0) {
          fake.listenLag--
          return { code: 1, output: 'rejecting connections' }
        }
        return { code: fake.running === Number(args[args.indexOf('-p') + 1]) ? 0 : 2, output: '' }
      }
      fake.calls.push({ tool: tool(file), args })
      if (tool(file) === 'initdb') {
        fake.passwordAtInitdb = await bootstrap.localPassword()
        const target = args[args.indexOf('-D') + 1]
        const pwfile = args.find((arg) => arg.startsWith('--pwfile='))!.slice('--pwfile='.length)
        expect((await readFile(pwfile, 'utf8')).trim()).toBe(fake.passwordAtInitdb)
        await mkdir(target, { recursive: true })
        await writeFile(join(target, 'PG_VERSION'), '18\n')
        await writeFile(join(target, 'postgresql.conf'), "#port = 5432\n")
        return { code: 0, output: 'ok' }
      }
      if (args[0] === 'status') {
        if (fake.running === null && fake.zombieStatus > 0) {
          fake.zombieStatus--
          return { code: 0, output: '' }
        }
        return { code: fake.running === null ? 3 : 0, output: '' }
      }
      if (args[0] === 'stop') {
        if (fake.fastStopFails && args.includes('fast')) return { code: 1, output: 'server does not shut down' }
        const wasRunning = fake.running !== null
        fake.running = null
        return { code: wasRunning ? 0 : 1, output: '' }
      }
      throw new Error(`comando inesperado: ${file} ${args.join(' ')}`)
    },
    start: async (file, args) => {
      fake.calls.push({ tool: tool(file), args })
      if (fake.startCode !== 0) {
        await writeFile(paths.logFile, 'LOG:  starting\nFATAL:  could not create any TCP/IP sockets\n')
        return { code: fake.startCode, output: '' }
      }
      const port = Number(/-p (\d+)/.exec(args[args.indexOf('-o') + 1])![1])
      fake.running = port
      await writeFile(join(paths.dataDir, 'postmaster.pid'), `1234\n${paths.dataDir}\n1700000000\n${port}\n\n127.0.0.1\n0\nready\n`)
      return { code: 0, output: '' }
    },
    portFree: async (port) => !fake.busy.has(port)
  }
  return { root, paths, bootstrap, fake, deps, server: new LocalPostgres(() => paths, deps) }
}

describe('LocalPostgres', () => {
  it('1ª abertura: guarda a senha antes do initdb, cria o cluster ao lado e renomeia, sobe só no loopback', async () => {
    const { paths, bootstrap, fake, server } = await setup()
    const draft = await server.ensure(bootstrap)

    expect(draft).toMatchObject({ host: '127.0.0.1', port: LOCAL_POSTGRES_PORT, user: 'agentcode', maintenanceDatabase: 'postgres', tlsMode: 'disable' })
    expect(draft.password.length).toBeGreaterThanOrEqual(30)
    expect(fake.passwordAtInitdb).toBe(draft.password)
    const initdb = fake.calls.find((call) => call.tool === 'initdb')!
    expect(initdb.args).toEqual(expect.arrayContaining(['-D', `${paths.dataDir}.init`, '-U', 'agentcode', '-E', 'UTF8', '--no-locale', '--auth=scram-sha-256']))
    expect(existsSync(join(paths.dataDir, 'PG_VERSION'))).toBe(true)
    expect(existsSync(`${paths.dataDir}.init`)).toBe(false)
    expect(await readFile(join(paths.dataDir, 'postgresql.conf'), 'utf8')).toContain("listen_addresses = '127.0.0.1'")
    // O arquivo da senha do initdb não fica para trás.
    expect((await readdir(join(paths.dataDir, '..'))).some((name) => name.endsWith('.pw'))).toBe(false)
    const start = fake.calls.find((call) => call.args[0] === 'start')!
    expect(start.args).toEqual(expect.arrayContaining(['-D', paths.dataDir, '-l', paths.logFile, '-w']))
    expect(start.args[start.args.indexOf('-o') + 1]).toBe(`-p ${LOCAL_POSTGRES_PORT} -c listen_addresses=127.0.0.1`)
  })

  it('servidor que sobrou de uma queda do app é reusado na porta em que está, sem initdb nem start', async () => {
    const { bootstrap, fake, server, paths, deps } = await setup()
    await server.ensure(bootstrap)
    fake.calls.length = 0
    const reopened = new LocalPostgres(() => paths, deps)
    const draft = await reopened.ensure(bootstrap)
    expect(draft.port).toBe(LOCAL_POSTGRES_PORT)
    expect(fake.calls.map((call) => call.args[0] ?? call.tool)).toEqual(['status'])
  })

  it('Postgres morto à força que o Windows ainda dá como vivo: espera o status concordar e sobe de novo', async () => {
    const { bootstrap, fake, server, paths, deps } = await setup()
    await server.ensure(bootstrap)
    fake.running = null // morto; o postmaster.pid ficou para trás
    fake.zombieStatus = 2
    fake.calls.length = 0
    const draft = await new LocalPostgres(() => paths, deps).ensure(bootstrap)
    expect(fake.calls.map((call) => call.args[0])).toEqual(['status', 'status', 'status', 'start'])
    expect(fake.running).toBe(draft.port)
  })

  it('pg_ctl diz "pronto" antes de o servidor aceitar conexões (pid velho recente): só devolve quando aceita', async () => {
    const { bootstrap, fake, server } = await setup({ listenLag: 3 })
    await server.ensure(bootstrap)
    expect(fake.listenProbes).toBe(4)
  })

  it('porta ocupada: escolhe a próxima livre e grava no bootstrap', async () => {
    const { bootstrap, server } = await setup({ busy: [LOCAL_POSTGRES_PORT, LOCAL_POSTGRES_PORT + 1] })
    const draft = await server.ensure(bootstrap)
    expect(draft.port).toBe(LOCAL_POSTGRES_PORT + 2)
    expect((await bootstrap.load()).local.port).toBe(LOCAL_POSTGRES_PORT + 2)
  })

  it('falha ao subir: erro com o motivo do log e o caminho dele', async () => {
    const { bootstrap, server, paths } = await setup({ startCode: 1 })
    await expect(server.ensure(bootstrap)).rejects.toMatchObject({
      code: 'LOCAL_POSTGRES_UNAVAILABLE',
      retryable: true,
      message: expect.stringContaining(paths.logFile)
    })
    await expect(server.ensure(bootstrap)).rejects.toThrow(/could not create any TCP\/IP sockets/)
  })

  it('initdb interrompido antes (sobra .init) é refeito; pasta de dados alheia não é apagada', async () => {
    const { bootstrap, server, paths } = await setup()
    await mkdir(`${paths.dataDir}.init`, { recursive: true })
    await writeFile(join(`${paths.dataDir}.init`, 'lixo'), 'x')
    await server.ensure(bootstrap)
    expect(existsSync(join(paths.dataDir, 'PG_VERSION'))).toBe(true)

    const other = await setup()
    await mkdir(other.paths.dataDir, { recursive: true })
    await writeFile(join(other.paths.dataDir, 'do-usuario.txt'), 'importante')
    await expect(other.server.ensure(other.bootstrap)).rejects.toMatchObject({ code: 'LOCAL_POSTGRES_UNAVAILABLE' })
    expect(await readFile(join(other.paths.dataDir, 'do-usuario.txt'), 'utf8')).toBe('importante')
  })

  it('banco existente sem a senha nesta instalação: erro claro, nada recriado', async () => {
    const { bootstrap, server, paths, fake } = await setup()
    await mkdir(paths.dataDir, { recursive: true })
    await writeFile(join(paths.dataDir, 'PG_VERSION'), '18\n')
    await expect(server.ensure(bootstrap)).rejects.toThrow(/senha/)
    expect(fake.calls.some((call) => call.tool === 'initdb')).toBe(false)
  })

  it('stop: fast; se não parar e ainda estiver de pé, immediate; sem uso nesta execução, nada', async () => {
    const idle = await setup({ running: 5555 })
    await idle.server.stop()
    expect(idle.fake.calls).toEqual([])

    const { bootstrap, server, fake } = await setup()
    await server.ensure(bootstrap)
    await server.stop()
    const modes = (calls: Fake['calls']) => calls.filter((call) => call.args[0] === 'stop').map((call) => call.args[call.args.indexOf('-m') + 1])
    expect(modes(fake.calls)).toEqual(['fast'])
    expect(fake.running).toBeNull()

    const stuck = await setup({ fastStopFails: true })
    await stuck.server.ensure(stuck.bootstrap)
    await stuck.server.stop()
    expect(modes(stuck.fake.calls)).toEqual(['fast', 'immediate'])
    expect(stuck.fake.running).toBeNull()
  })

  it('chamadas simultâneas dividem a mesma subida', async () => {
    const { bootstrap, server, fake } = await setup()
    const [a, b] = await Promise.all([server.ensure(bootstrap), server.ensure(bootstrap)])
    expect(a).toEqual(b)
    expect(fake.calls.filter((call) => call.tool === 'initdb')).toHaveLength(1)
    expect(fake.calls.filter((call) => call.args[0] === 'start')).toHaveLength(1)
  })

  it('sem binários: erro dizendo como preparar', () => {
    expect(() => localPostgresPaths([join(tmpdir(), 'nao-existe')], 'x')).toThrow(/postgres:stage/)
  })
})
