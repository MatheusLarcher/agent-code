import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import type { PostgresConnectionDraft } from '../../shared/ipc'
import type { BootstrapStore } from './bootstrapStore'
import { StorageError } from './types'

/**
 * O PostgreSQL embutido (scripts/stage-postgres.mjs → resources/postgres): o app
 * cria o cluster na primeira abertura, sobe o servidor ao abrir e o derruba ao
 * fechar — sem serviço do Windows, sem UAC, sem janela. Ele roda FORA do processo
 * do Electron: um main travado não derruba o banco, e um servidor que sobrou de
 * uma queda do app é reusado na abertura seguinte.
 */

export const LOCAL_POSTGRES_USER = 'agentcode'

export interface LocalPostgresPaths {
  /** Pasta com initdb.exe, pg_ctl.exe e postgres.exe. */
  binDir: string
  /** PGDATA. Fora do OneDrive (machineLocalDir); backup é pg_dump, nunca cópia da pasta. */
  dataDir: string
  /** Saída do servidor (`pg_ctl -l`): é o caminho que a tela de recuperação mostra. */
  logFile: string
}

export interface CommandResult {
  code: number
  output: string
}

export interface LocalPostgresDeps {
  /** initdb, pg_ctl status/stop e pg_isready: saída capturada. */
  run(file: string, args: string[], timeoutMs: number): Promise<CommandResult>
  /** pg_ctl start: SEM pipes — o servidor (neto, via cmd.exe) herdaria a ponta de
   *  escrita e o fim da saída só chegaria quando ele parasse. */
  start(file: string, args: string[], timeoutMs: number): Promise<CommandResult>
  portFree(port: number): Promise<boolean>
}

type Readiness = 'ready' | 'starting' | 'down'

const INITDB_TIMEOUT_MS = 180_000
const START_WAIT_SECONDS = 90
const STATUS_TIMEOUT_MS = 15_000
const PROBE_TIMEOUT_MS = 10_000
const ALIVE_WAIT_MS = 10_000
const STOP_WAIT_SECONDS = 10
const PORT_ATTEMPTS = 50
const LOG_ROTATE_BYTES = 10 * 1024 * 1024
// ASCII de propósito: é o postgresql.conf. A porta não vai aqui — vem do app a
// cada partida (-p), para seguir o que está gravado no bootstrap.
const CONF_BLOCK = "\n# Agent Code: atende so esta maquina; a porta vem do app (pg_ctl -o -p).\nlisten_addresses = '127.0.0.1'\n"

/**
 * Pastas do cluster que ficam VAZIAS no uso normal (sem tablespace, slot, transação
 * preparada, arquivamento…). Um limpador de "pastas vazias" de fora as apaga, e sem elas
 * o Postgres não sobe ("could not open directory pg_notify"). Se sumiram, estavam vazias:
 * recriá-las vazias devolve o estado de antes. As que guardam dados (pg_xact,
 * pg_multixact) ficam de fora — faltando, o erro do Postgres aparece como é.
 */
export const EMPTY_CLUSTER_DIRS = [
  'pg_commit_ts', 'pg_dynshmem', 'pg_logical/mappings', 'pg_logical/snapshots', 'pg_notify', 'pg_replslot', 'pg_serial',
  'pg_snapshots', 'pg_stat', 'pg_stat_tmp', 'pg_subtrans', 'pg_tblspc', 'pg_twophase', 'pg_wal/archive_status', 'pg_wal/summaries'
] as const

/** Recria as EMPTY_CLUSTER_DIRS que faltam; devolve as recriadas. */
export async function restoreEmptyClusterDirs(dataDir: string): Promise<string[]> {
  const restored: string[] = []
  for (const dir of EMPTY_CLUSTER_DIRS) {
    const path = join(dataDir, ...dir.split('/'))
    if (await stat(path).then(() => true, () => false)) continue
    await mkdir(path, { recursive: true })
    restored.push(dir)
  }
  return restored
}

/** Acha os binários: resources/postgres no app instalado, out/postgres em desenvolvimento. */
export function localPostgresPaths(resourceRoots: string[], localRoot: string): LocalPostgresPaths {
  const binDir = resourceRoots
    .map((root) => join(root, 'postgres', 'bin'))
    .find((bin) => existsSync(join(bin, 'pg_ctl.exe')))
  if (!binDir) {
    throw new StorageError(
      'LOCAL_POSTGRES_UNAVAILABLE',
      'O PostgreSQL embutido não foi encontrado nesta instalação (em desenvolvimento: npm run postgres:stage).'
    )
  }
  return { binDir, dataDir: join(localRoot, 'pgdata'), logFile: join(localRoot, 'postgres.log') }
}

export class LocalPostgres {
  private ensuring: Promise<PostgresConnectionDraft> | null = null
  private used = false

  constructor(
    private readonly resolvePaths: () => LocalPostgresPaths,
    private readonly deps: LocalPostgresDeps = defaultDeps
  ) {}

  /** Cria o cluster se faltar, sobe (ou reusa) o servidor e devolve a conexão.
   *  Chamadas simultâneas (abertura e reconexão) dividem a mesma subida. */
  ensure(bootstrap: BootstrapStore): Promise<PostgresConnectionDraft> {
    this.ensuring ??= this.ensureOnce(bootstrap)
      .catch((error: unknown) => {
        if (error instanceof StorageError) throw error
        throw failure('O PostgreSQL local não respondeu.', this.resolvePaths(), error)
      })
      .finally(() => {
        this.ensuring = null
      })
    return this.ensuring
  }

  /** `pg_ctl stop -m fast` (checkpoint e saída limpa); se não parar a tempo,
   *  `immediate` — o próximo start se recupera pelo WAL. Só para o que esta
   *  execução subiu ou reusou. */
  async stop(): Promise<void> {
    await this.ensuring?.catch(() => undefined)
    if (!this.used) return
    this.used = false
    const paths = this.resolvePaths()
    const pgCtl = join(paths.binDir, 'pg_ctl.exe')
    const stopWith = (mode: 'fast' | 'immediate'): Promise<CommandResult | null> =>
      this.deps
        .run(pgCtl, ['stop', '-D', paths.dataDir, '-m', mode, '-w', '-t', String(STOP_WAIT_SECONDS), '-s'], (STOP_WAIT_SECONDS + 10) * 1000)
        .catch(() => null)
    if ((await stopWith('fast'))?.code === 0) return
    if (!(await this.statusRunning(paths))) return
    await stopWith('immediate')
  }

  private async ensureOnce(bootstrap: BootstrapStore): Promise<PostgresConnectionDraft> {
    const paths = this.resolvePaths()
    let password = await bootstrap.localPassword()
    if (!existsSync(join(paths.dataDir, 'PG_VERSION'))) {
      if (!password) {
        // Guardada ANTES do initdb: nunca existe cluster cuja senha o app não tenha.
        password = randomBytes(24).toString('base64url')
        await bootstrap.saveLocalPassword(password)
      }
      await this.initCluster(paths, password)
    } else if (!password) {
      throw failure('O banco local existe, mas a senha dele não está mais nesta instalação.', paths)
    }
    this.used = true
    let port = await this.runningPort(paths)
    if (port === null) {
      const saved = (await bootstrap.load()).local.port
      port = await this.freePort(saved, paths)
      if (port !== saved) await bootstrap.saveLocalPort(port)
      await this.startServer(paths, port)
    }
    await this.waitReady(paths, port)
    return {
      host: '127.0.0.1',
      port,
      user: LOCAL_POSTGRES_USER,
      password,
      maintenanceDatabase: 'postgres',
      tlsMode: 'disable',
      ca: ''
    }
  }

  /** initdb numa pasta ao lado e rename no fim: um initdb interrompido (app
   *  morto no meio) nunca deixa um PGDATA pela metade no lugar do bom. */
  private async initCluster(paths: LocalPostgresPaths, password: string): Promise<void> {
    const staging = `${paths.dataDir}.init`
    await rm(staging, { recursive: true, force: true })
    const existing = await readdir(paths.dataDir).catch(() => null)
    if (existing?.length) throw failure(`A pasta ${paths.dataDir} tem arquivos, mas não é um banco PostgreSQL.`, paths)
    if (existing) await rm(paths.dataDir, { recursive: true, force: true })
    await mkdir(dirname(paths.dataDir), { recursive: true })
    const passwordFile = join(dirname(paths.dataDir), `.initdb-${process.pid}.pw`)
    await writeFile(passwordFile, `${password}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      const result = await this.deps.run(
        join(paths.binDir, 'initdb.exe'),
        ['-D', staging, '-U', LOCAL_POSTGRES_USER, `--pwfile=${passwordFile}`, '-E', 'UTF8', '--no-locale', '--auth=scram-sha-256', '--no-instructions'],
        INITDB_TIMEOUT_MS
      )
      if (result.code !== 0) throw failure(`O initdb falhou (código ${result.code}): ${lastLines(result.output)}`, paths)
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw error instanceof StorageError ? error : failure('O initdb não terminou.', paths, error)
    } finally {
      await rm(passwordFile, { force: true }).catch(() => undefined)
    }
    await appendFile(join(staging, 'postgresql.conf'), CONF_BLOCK, 'utf8')
    await renameWithRetry(staging, paths.dataDir)
  }

  /** Porta do servidor desta pasta que já está de pé (sobrou de uma queda do
   *  app); `null` se ele está parado — o pid velho de uma queda o pg_ctl
   *  descarta. Logo depois de o Postgres morrer à força o Windows ainda o dá como
   *  vivo por instantes (o pipe de sinal demora a sumir): sem ninguém na porta,
   *  espera o pg_ctl concordar que parou, em vez de devolver uma porta morta. */
  private async runningPort(paths: LocalPostgresPaths): Promise<number | null> {
    const deadline = Date.now() + ALIVE_WAIT_MS
    for (;;) {
      if (!(await this.statusRunning(paths))) return null
      const lines = (await readFile(join(paths.dataDir, 'postmaster.pid'), 'utf8').catch(() => '')).split(/\r?\n/)
      const port = Number(lines[3])
      if (Number.isInteger(port) && port > 0 && (await this.probe(paths, port)) !== 'down') return port
      if (Date.now() >= deadline) throw failure('O PostgreSQL local consta como de pé, mas não atende na porta dele.', paths)
      await delay(250)
    }
  }

  /** pg_isready (sem senha): 0 aceita conexões, 1 ainda subindo (recuperação pelo
   *  WAL), 2 ninguém responde. */
  private async probe(paths: LocalPostgresPaths, port: number): Promise<Readiness> {
    const result = await this.deps.run(
      join(paths.binDir, 'pg_isready.exe'),
      ['-h', '127.0.0.1', '-p', String(port), '-t', '3'],
      PROBE_TIMEOUT_MS
    )
    return result.code === 0 ? 'ready' : result.code === 1 ? 'starting' : 'down'
  }

  /** Só devolve a conexão com o servidor aceitando conexões. O `pg_ctl start -w`
   *  não basta: com o postmaster.pid velho de um Postgres morto há menos de 2 s
   *  (dentro da folga dele), ele dá "pronto" antes de o novo sequer escutar. */
  private async waitReady(paths: LocalPostgresPaths, port: number): Promise<void> {
    const deadline = Date.now() + START_WAIT_SECONDS * 1000
    let state = await this.probe(paths, port)
    while (state !== 'ready') {
      if (Date.now() >= deadline) {
        const tail = lastLines(await readFile(paths.logFile, 'utf8').catch(() => ''))
        throw failure(`O PostgreSQL local não ficou pronto na porta ${port}${tail ? `: ${tail}` : '.'}`, paths)
      }
      await delay(250)
      state = await this.probe(paths, port)
    }
  }

  private async statusRunning(paths: LocalPostgresPaths): Promise<boolean> {
    const status = await this.deps.run(join(paths.binDir, 'pg_ctl.exe'), ['status', '-D', paths.dataDir], STATUS_TIMEOUT_MS)
    return status.code === 0
  }

  private async freePort(preferred: number, paths: LocalPostgresPaths): Promise<number> {
    for (let port = preferred; port < preferred + PORT_ATTEMPTS && port <= 65_535; port++) {
      if (await this.deps.portFree(port)) return port
    }
    throw failure(`Nenhuma porta livre entre ${preferred} e ${preferred + PORT_ATTEMPTS - 1}.`, paths)
  }

  private async startServer(paths: LocalPostgresPaths, port: number): Promise<void> {
    await rotateLog(paths.logFile)
    const restored = await restoreEmptyClusterDirs(paths.dataDir)
    if (restored.length) {
      await appendFile(paths.logFile, `Agent Code: pastas vazias do cluster que faltavam, recriadas antes de subir: ${restored.join(', ')}\n`, 'utf8').catch(() => undefined)
    }
    const result = await this.deps
      .start(
        join(paths.binDir, 'pg_ctl.exe'),
        ['start', '-D', paths.dataDir, '-l', paths.logFile, '-w', '-t', String(START_WAIT_SECONDS), '-s', '-o', `-p ${port} -c listen_addresses=127.0.0.1`],
        (START_WAIT_SECONDS + 15) * 1000
      )
      .catch((error: unknown) => {
        throw failure('O PostgreSQL local não subiu.', paths, error)
      })
    if (result.code !== 0) {
      const tail = lastLines(await readFile(paths.logFile, 'utf8').catch(() => ''))
      throw failure(`O PostgreSQL local não subiu (pg_ctl saiu com ${result.code})${tail ? `: ${tail}` : '.'}`, paths)
    }
  }
}

function failure(detail: string, paths: LocalPostgresPaths, cause?: unknown): StorageError {
  return new StorageError('LOCAL_POSTGRES_UNAVAILABLE', `${detail} Log do PostgreSQL: ${paths.logFile}`, true, { cause })
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** O motivo, para a tela: as linhas FATAL/PANIC/ERROR (sem data e pid) ou, sem
 *  elas, as últimas linhas da saída. */
function lastLines(text: string, count = 2): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const severe = lines.filter((line) => /\b(FATAL|PANIC|ERROR):/.test(line))
  const reasons = (severe.length ? severe : lines).map((line) => line.replace(/^\d{4}-\d\d-\d\d [\d:.]+ \S+ \[\d+\]\s+/, ''))
  // Tentativas repetidas deixam a mesma linha no log várias vezes.
  return [...new Set(reasons)].slice(-count).join(' | ')
}

/** Recomeça o log acima de 10 MB (guarda o anterior em .1): com `-l` o servidor
 *  só acrescenta. Roda antes do start, com o servidor parado. */
async function rotateLog(file: string): Promise<void> {
  const info = await stat(file).catch(() => null)
  if (!info || info.size < LOG_ROTATE_BYTES) return
  await rm(`${file}.1`, { force: true }).catch(() => undefined)
  await rename(file, `${file}.1`).catch(() => undefined)
}

/** O antivírus costuma segurar por instantes os arquivos que o initdb acabou de criar. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (attempt >= 10) throw error
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
}

/** PGPORT/PGDATA/PGUSER… do ambiente mudariam o servidor (o postgres lê PGPORT) e
 *  as ferramentas (também o pg_dump/pg_restore dos backups, backup/pgTools.ts);
 *  LC_MESSAGES=C deixa log e erros em inglês, sem acento. */
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!/^(PG|LC_|LANG)/i.test(key)) env[key] = value
  env['LC_MESSAGES'] = 'C'
  return env
}

export const defaultDeps: LocalPostgresDeps = {
  run: (file, args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(file, args, { windowsHide: true, timeout: timeoutMs, env: childEnv(), maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`
        if (!error) return resolve({ code: 0, output })
        const code = (error as { code?: unknown }).code
        if (typeof code === 'number') return resolve({ code, output })
        reject(error)
      })
    }),
  start: (file, args, timeoutMs) =>
    new Promise((resolve, reject) => {
      const child = spawn(file, args, { windowsHide: true, stdio: 'ignore', env: childEnv() })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`pg_ctl start não respondeu em ${timeoutMs} ms`))
      }, timeoutMs)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? 1, output: '' })
      })
    }),
  portFree: (port) =>
    new Promise((resolve) => {
      const server = createServer()
      server.once('error', () => resolve(false))
      // Só no loopback: escutar em 0.0.0.0 faria o firewall do Windows perguntar.
      server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)))
    })
}
