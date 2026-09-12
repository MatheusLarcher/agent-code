// Roda a suíte de integração PostgreSQL num container descartável: sobe o
// postgres:16-alpine, espera ele aceitar conexão TCP, roda os testes em série e
// derruba o container — inclusive quando o teste falha ou o script é
// interrompido.
//
//   npm run test:pg
//
// Existe porque o ritual equivalente era documentado e não executado: ninguém
// rodava o docker run + vitest à mão, e um teste quebrado atravessou dois
// commits sem acusar.
//
// Porta e senha saem de AGENT_CODE_PG_PORT / AGENT_CODE_PG_PASSWORD, os mesmos
// nomes que os testes leem, então container e suíte não têm como divergir.
import { spawn, spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

const CONTAINER = 'agent-code-pg-test'
const IMAGE = 'postgres:16-alpine'
const HOST = '127.0.0.1'
const READY_TIMEOUT_MS = 90_000
const READY_INTERVAL_MS = 500

// 15432 e não os 55432 que a doc pedia: o Windows reserva faixas inteiras de
// porta para o WinNAT/Hyper-V (`netsh interface ipv4 show excludedportrange
// protocol=tcp`) e nesta máquina 55432 cai dentro de uma delas. O `docker run`
// morre com "bind: An attempt was made to access a socket in a way forbidden by
// its access permissions", que não denuncia a porta como culpada.
const port = process.env.AGENT_CODE_PG_PORT ?? '15432'
const password = process.env.AGENT_CODE_PG_PASSWORD ?? 'agent-code-test-password'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function docker(args, options = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...options })
}

let containerRemoved = true

function removeContainer() {
  if (containerRemoved) return
  containerRemoved = true
  docker(['rm', '--force', '--volumes', CONTAINER], { stdio: 'ignore' })
}

// Rede de segurança: toda saída passa por aqui — falha de teste, exceção,
// Ctrl+C. Container órfão segurando a porta é o que faz a execução seguinte
// falhar sem motivo aparente, e o handler de 'exit' é síncrono como o spawnSync.
process.on('exit', removeContainer)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => {
    removeContainer()
    process.exit(130)
  })
}

function fail(message) {
  console.error(`[test:pg] ${message}`)
  process.exit(1)
}

function ensureDocker() {
  const probe = docker(['version', '--format', '{{.Server.Version}}'])
  if (probe.error || probe.status !== 0) {
    fail(`Docker não respondeu. Docker Desktop precisa estar rodando.\n${(probe.stderr ?? probe.error?.message ?? '').trim()}`)
  }
}

function containerLogs() {
  const logs = docker(['logs', '--tail', '20', CONTAINER])
  return `${logs.stdout ?? ''}${logs.stderr ?? ''}`.trim()
}

function containerRunning() {
  const inspect = docker(['inspect', '--format', '{{.State.Running}}', CONTAINER])
  return inspect.status === 0 && inspect.stdout.trim() === 'true'
}

function startContainer() {
  // Órfão de uma execução morta à força (taskkill, reboot) não roda handler
  // nenhum, então a limpeza também acontece na entrada.
  docker(['rm', '--force', '--volumes', CONTAINER], { stdio: 'ignore' })
  containerRemoved = false
  const run = docker([
    'run',
    '--detach',
    '--name',
    CONTAINER,
    '--publish',
    `${HOST}:${port}:5432`,
    '--env',
    `POSTGRES_PASSWORD=${password}`,
    IMAGE
  ])
  if (run.status !== 0) {
    fail(
      `Não subiu o container na porta ${port}.\n${(run.stderr ?? '').trim()}\n` +
        'Se for conflito ou faixa reservada do Windows, escolha outra com AGENT_CODE_PG_PORT.'
    )
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForPostgres() {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let lastError = 'sem tentativa'
  while (Date.now() < deadline) {
    // `pg_isready` de dentro do container diz "ready" ainda durante o initdb,
    // quando o servidor temporário escuta só no socket unix. Quem a suíte usa é
    // o TCP publicado, então é o TCP que vale como pronto.
    const client = new Client({
      host: HOST,
      port: Number(port),
      user: 'postgres',
      password,
      database: 'postgres',
      connectionTimeoutMillis: 3_000
    })
    try {
      await client.connect()
      await client.query('SELECT 1')
      await client.end()
      return
    } catch (error) {
      lastError = error?.message ?? String(error)
      await client.end().catch(() => {})
    }
    if (!containerRunning()) {
      throw new Error(`O container ${CONTAINER} parou durante a inicialização.\n${containerLogs()}`)
    }
    await delay(READY_INTERVAL_MS)
  }
  throw new Error(
    `PostgreSQL não aceitou conexão em ${HOST}:${port} em ${READY_TIMEOUT_MS / 1000}s.\n` +
      `Último erro: ${lastError}\n${containerLogs()}`
  )
}

function testFiles() {
  const persistence = readdirSync(new URL('../src/main/persistence/', import.meta.url))
    .filter((name) => /^postgres.*\.test\.ts$/.test(name))
    .sort()
    .map((name) => `src/main/persistence/${name}`)
  return [...persistence, 'src/main/tasks/taskLedger.test.ts']
}

function runVitest(files) {
  const vitestBin = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs')
  // --no-file-parallelism: os arquivos recriam o MESMO banco `agent-code`; em
  // paralelo um derruba as conexões do outro (FATAL 57P01) e a falha parece bug
  // do código.
  const args = [vitestBin, 'run', '--no-file-parallelism', ...files]
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        AGENT_CODE_PG_INTEGRATION: '1',
        AGENT_CODE_PG_HOST: HOST,
        AGENT_CODE_PG_PORT: port,
        AGENT_CODE_PG_PASSWORD: password
      }
    })
    child.on('error', (error) => {
      console.error(`[test:pg] falha ao executar o vitest: ${error.message}`)
      resolve(1)
    })
    // Morto por sinal não tem exit code; 1 mantém a falha visível para o CI.
    child.on('close', (code, signal) => resolve(signal ? 1 : (code ?? 1)))
  })
}

ensureDocker()
console.log(`[test:pg] subindo ${IMAGE} como ${CONTAINER} em ${HOST}:${port}`)
startContainer()
try {
  await waitForPostgres()
  console.log('[test:pg] PostgreSQL pronto; rodando a suíte em série')
  process.exitCode = await runVitest(testFiles())
} catch (error) {
  console.error(`[test:pg] ${error.message}`)
  process.exitCode = 1
} finally {
  removeContainer()
  console.log(`[test:pg] container ${CONTAINER} removido`)
}
