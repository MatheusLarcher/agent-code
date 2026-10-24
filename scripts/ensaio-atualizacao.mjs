// Ensaio da atualização automática numa instância ISOLADA, sem instalar nada.
//
//   1) node scripts/dev-update-feed.mjs           (num terminal; serve dist/ como versão nova)
//   2) node scripts/ensaio-atualizacao.mjs        (este script)
//
// Abre `electron .` com AGENT_CODE_DEV_DATA_DIR (dados próprios, Postgres próprio),
// AGENT_CODE_DEV_UPDATE_FEED=1 (lê dev-app-update.yml) e AGENT_CODE_DEV_UPDATE_DRY_INSTALL=1
// (faz o fechamento ordenado inteiro e sai SEM chamar o instalador). Prova, com
// capturas e logs em out/ensaio-atualizacao (gitignored): detecção → download →
// pronta → popover nos dois ramos → agendamento com um turno em andamento → turno
// novo recusado → fim do turno dispara a sequência → o app sai sozinho.
// Usa a conta Claude logada na máquina para um turno curto (`sleep 75` no Bash).
import { _electron as electron } from 'playwright'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..')
const base = join(repo, 'out', 'ensaio-atualizacao')
const dataDir = join(base, 'data')
const projectDir = join(base, 'projeto')
const shots = join(base, 'capturas')
for (const dir of [dataDir, projectDir, shots]) mkdirSync(dir, { recursive: true })
const logFile = join(base, 'ensaio.log')
const log = (message) => {
  const line = `[${new Date().toISOString()}] ${message}`
  console.log(line)
  appendFileSync(logFile, `${line}\n`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn, timeoutMs, every = 500) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`tempo esgotado (${timeoutMs} ms)`)
    await sleep(every)
  }
}
const text = (s) => s.replace(/\s*\n\s*/g, ' | ').trim()
/** Clique pelo DOM (o botão fica sob a camada de tooltip do app; o clique de mouse do Playwright não chegava nele). */
const clickDom = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) throw new Error(`não achei ${sel}`)
    el.click()
  }, selector)
const clickText = (page, selector, label) =>
  page.evaluate(
    ({ sel, label }) => {
      const el = Array.from(document.querySelectorAll(sel)).find((b) => b.textContent?.trim() === label)
      if (!el) throw new Error(`não achei "${label}" em ${sel}`)
      el.click()
    },
    { sel: selector, label }
  )

const env = {}
for (const [key, value] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC)/i.test(key)) env[key] = value
Object.assign(env, { AGENT_CODE_DEV_DATA_DIR: dataDir, AGENT_CODE_DEV_UPDATE_FEED: '1', AGENT_CODE_DEV_UPDATE_DRY_INSTALL: '1' })

log('abrindo a instância isolada (electron . com feed local e dry-install)')
const app = await electron.launch({
  executablePath: join(repo, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: ['.'],
  cwd: repo,
  env,
  timeout: 180_000
})
log(`pid principal ${app.process().pid}`)
app.process().stdout?.on('data', (chunk) => appendFileSync(join(base, 'electron-stdout.log'), chunk))
app.process().stderr?.on('data', (chunk) => appendFileSync(join(base, 'electron-stderr.log'), chunk))
let closedAt = 0
const closed = new Promise((resolve) =>
  app.on('close', () => {
    closedAt = Date.now()
    resolve()
  })
)

const page = await app.firstWindow({ timeout: 180_000 })
// Diálogo do fechamento pode já ter sumido quando o accept chega: não é falha do ensaio.
page.on('dialog', (dialog) => void dialog.accept().catch(() => undefined))
await page.waitForFunction(() => typeof window.api?.getUpdateState === 'function', null, { timeout: 120_000 })
await page.waitForFunction(
  async () => {
    const status = await window.api.getStorageStatus()
    return !!status && status.state !== 'booting'
  },
  null,
  { timeout: 180_000 }
)
const state = () => page.evaluate(() => window.api.getUpdateState()).catch(() => null)
log(`armazenamento: ${JSON.stringify(await page.evaluate(() => window.api.getStorageStatus()))}`)
log(`estado inicial: ${JSON.stringify(await state())}`)
// Qualquer falha daqui em diante: captura da tela e o app fechado.
process.on('uncaughtException', async (error) => {
  log(`FALHA: ${error?.stack ?? error}`)
  await page.screenshot({ path: join(shots, 'erro.png') }).catch(() => undefined)
  log(`tela: ${text((await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 600))}`)
  await app.close().catch(() => undefined)
  process.exit(1)
})
// Eventos das sessões, para ver a recusa do turno novo.
await page.evaluate(() => {
  window.__eventos = []
  window.api.onAgentEvent((m) => window.__eventos.push(m))
})

// 1) Detecção + download pelo feed local.
const t0 = Date.now()
await page.evaluate(() => window.api.updateCheckNow())
let lastKey = ''
const ready = await until(
  async () => {
    const s = await state()
    if (!s) return null
    const key = `${s.phase} ${s.percent ?? ''} ${s.error ?? ''}`
    if (key !== lastKey) {
      lastKey = key
      log(`estado: ${JSON.stringify(s)}`)
    }
    if (s.phase === 'pronta') return s
    if (s.phase === 'erro') throw new Error(`erro na atualização: ${s.error}`)
    return null
  },
  300_000,
  1000
)
log(`pronta ${ready.version} em ${Math.round((Date.now() - t0) / 1000)} s (detecção + download + conferência do sha512)`)

// 2) Indicador e popover com os agentes parados.
await until(() => page.locator('.update-trigger').count(), 10_000)
await page.screenshot({ path: join(shots, '1-barra-pronta.png') })
await clickDom(page, '.update-trigger')
await page.waitForSelector('.update-popover', { timeout: 5_000 })
log(`popover (agentes parados): ${text(await page.locator('.update-popover').innerText())}`)
await page.screenshot({ path: join(shots, '2-popover-atualizar-agora.png') })
log(`foco ao abrir: ${await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '(nenhum)')}`)
await page.keyboard.press('Escape')
log(`Esc fecha o popover: ${(await page.locator('.update-popover').count()) === 0}`)

// 3) Um turno longo em andamento: o ramo "quando os agentes terminarem".
const convId = 'ensaio-atualizacao-1'
const started = await page.evaluate(
  ({ convId, cwd }) => window.api.startAgent({ convId, cwd, model: 'claude-sonnet-5-5', effort: 'low', skipPermissions: true }),
  { convId, cwd: projectDir }
)
log(`startAgent: ${JSON.stringify(started)}`)
await page.evaluate(
  ({ convId }) =>
    window.api.sendMessage(
      convId,
      'Rode no Bash, em primeiro plano (sem run_in_background), exatamente o comando `sleep 45`, espere ele terminar e depois responda só: ok'
    ),
  { convId }
)
const turnStart = Date.now()
// Só agenda com o Bash de fato rodando: o hook UserPromptSubmit recusa o prompt se a
// retenção entrar antes de o CLI subir (~3 s), e aí o turno acabaria sem trabalho nenhum.
await until(
  () =>
    page.evaluate(
      ({ convId }) => window.__eventos.some((m) => m.convId === convId && m.event?.kind === 'tool-use'),
      { convId }
    ),
  120_000,
  500
)
const busy = await until(
  async () => {
    const s = await state()
    return s?.blockedBy ? s : null
  },
  30_000,
  500
)
log(`agente trabalhando (Bash em execução): ${busy.blockedBy} (canInstallNow=${busy.canInstallNow})`)
await clickDom(page, '.update-trigger')
await page.waitForSelector('.update-popover', { timeout: 5_000 })
log(`popover (agente trabalhando): ${text(await page.locator('.update-popover').innerText())}`)
await page.screenshot({ path: join(shots, '3-popover-quando-terminarem.png') })
await clickText(page, '.update-popover button', 'Atualizar quando os agentes terminarem')
const scheduled = await until(
  async () => {
    const s = await state()
    return s?.phase === 'agendada' ? s : null
  },
  10_000
)
log(`agendada: ${JSON.stringify(scheduled)}`)
// Ao agendar, o popover continua aberto já com o conteúdo de "agendada" (clicar no gatilho fecharia).
if ((await page.locator('.update-popover').count()) === 0) await clickDom(page, '.update-trigger')
await page.waitForSelector('.update-popover', { timeout: 5_000 })
log(`popover (agendada): ${text(await page.locator('.update-popover').innerText())}`)
await page.screenshot({ path: join(shots, '4-popover-agendada.png') })
await page.keyboard.press('Escape')

// 4) Trabalho novo é recusado com a mensagem da retenção (hook UserPromptSubmit).
const conv2 = 'ensaio-atualizacao-2'
const newConv = await page.evaluate(
  ({ convId, cwd }) =>
    window.api
      .startAgent({ convId, cwd, model: 'claude-sonnet-5-5', effort: 'low', skipPermissions: true })
      .then((r) => `start ok ${JSON.stringify(r)}`, (e) => `start RECUSADO: ${e?.message ?? e}`),
  { convId: conv2, cwd: projectDir }
)
log(`nova conversa durante o agendamento: ${newConv}`)
const sent2 = await page.evaluate(
  ({ convId }) => window.api.sendMessage(convId, 'Responda só: oi').then(() => 'send aceito', (e) => `send RECUSADO: ${e?.message ?? e}`),
  { convId: conv2 }
)
log(`envio na conversa nova: ${sent2}`)
const end2 = await page
  .evaluate(({ convId }) => window.api.waitTurnEnd(convId).then((r) => JSON.stringify(r), (e) => `erro: ${e?.message ?? e}`), { convId: conv2 })
  .catch((error) => `evaluate falhou: ${error.message}`)
log(`turno da conversa nova terminou: ${end2}`)
const events2 = await page
  .evaluate(({ convId }) => JSON.stringify(window.__eventos.filter((m) => m.convId === convId).map((m) => m.event ?? m)).slice(0, 2500), { convId: conv2 })
  .catch(() => '(sem eventos)')
log(`eventos da conversa nova: ${events2}`)

// 5) O turno termina → a retenção dispara → fechamento ordenado (dry-install) → o app sai.
const turnEnd = await page
  .evaluate(({ convId }) => window.api.waitTurnEnd(convId).then((r) => JSON.stringify(r), (e) => `erro: ${e?.message ?? e}`), { convId })
  .catch((error) => `evaluate falhou (janela fechou?): ${error.message}`)
const turnEndAt = Date.now()
log(`turno terminou após ${Math.round((turnEndAt - turnStart) / 1000)} s: ${turnEnd}`)
const events1 = await page
  .evaluate(
    ({ convId }) =>
      window.__eventos
        .filter((m) => m.convId === convId)
        .map((m) => (m.event?.kind === 'tool-use' ? `tool-use:${m.event.name}` : m.event?.kind ?? '?'))
        .join(' '),
    { convId }
  )
  .catch(() => '(sem eventos)')
log(`eventos da conversa 1: ${events1.slice(0, 600)}`)
try {
  let lastAfter = ''
  await until(
    async () => {
      const s = await state()
      if (!s) return null
      const key = `${s.phase} ${s.blockedBy ?? ''}`
      if (key !== lastAfter) {
        lastAfter = key
        log(`estado após o turno: ${JSON.stringify(s)}`)
      }
      return s.phase === 'instalando' ? s : null
    },
    90_000,
    200
  )
  // A janela é escondida 3 ms depois de a fase virar "instalando": a captura raramente dá tempo.
  await page.screenshot({ path: join(shots, '5-instalando.png'), timeout: 3_000 })
  log('faixa "instalando" capturada')
} catch (error) {
  log(`faixa "instalando" não capturada (janela já escondida pelo fechamento): ${error.message.split('\n')[0]}`)
}
await Promise.race([closed, sleep(240_000)])
if (!closedAt) {
  log('o app NÃO fechou sozinho em 4 min; encerrando')
  await app.close().catch(() => undefined)
} else {
  log(`o app fechou sozinho ${Math.round((closedAt - turnEndAt) / 1000)} s depois do fim do turno`)
}

// 6) Logs da instância isolada.
const updateLog = join(dataDir, 'userData', 'logs', 'atualizacao.log')
log('--- atualizacao.log ---')
log(existsSync(updateLog) ? readFileSync(updateLog, 'utf8') : '(não existe)')
const pgLog = join(dataDir, 'localappdata', 'agent-code', 'postgres.log')
log('--- postgres.log (últimas linhas) ---')
log(existsSync(pgLog) ? readFileSync(pgLog, 'utf8').trim().split('\n').slice(-6).join('\n') : '(não existe)')
log('fim do ensaio')
process.exit(0)
