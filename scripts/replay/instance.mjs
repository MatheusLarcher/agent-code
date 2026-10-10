// Instância isolada do Agent Code para o replay: abre o app deste repositório pelo
// Playwright (_electron) com pasta de dados própria, liga a ponte do celular só em
// 127.0.0.1 (gancho de dev, sem relay) e expõe o cliente HTTP dela.
// Regras: AGENT_CODE_DEV_DATA_DIR sempre definido (desliga o curador de memórias),
// variáveis CLAUDE_*/ANTHROPIC_* removidas (não vazam a conta do app pai).
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

export const APP_ROOT = 'C:/GitHub/agent-code'
/** Workers do vitest nas rodadas e na avaliação (ver isolatedEnv). */
export const VITEST_WORKERS = '4'

/** Memória comprometida livre do Windows, em GB. */
export function freeCommitGb() {
  try {
    const kb = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory'], { encoding: 'utf8' }).trim()
    return Number(kb) / 1024 / 1024
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Espera haver memória comprometida livre antes de um passo pesado (abrir a instância,
 * rodar a suíte). O PC do usuário roda outras coisas grandes (emulador, Bambu Studio):
 * esgotar a memória derruba processos dele, inclusive o Agent Code em uso. Por padrão
 * espera sem limite — o teste para, o PC do usuário não.
 */
export async function waitForMemory(minGb, { maxWaitMs = Number.POSITIVE_INFINITY, log = console.log } = {}) {
  const t0 = Date.now()
  let free = freeCommitGb()
  if (free >= minGb) return { waitedMs: 0, free }
  log(`[memória] ${free.toFixed(1)} GB livres; esperando ${minGb} GB antes de seguir`)
  let lastLog = Date.now()
  while (free < minGb && Date.now() - t0 < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 30_000))
    free = freeCommitGb()
    if (Date.now() - lastLog > 10 * 60_000) {
      log(`[memória] ainda esperando: ${free.toFixed(1)} GB livres há ${Math.round((Date.now() - t0) / 60000)} min`)
      lastLog = Date.now()
    }
  }
  log(`[memória] seguindo com ${free.toFixed(1)} GB livres após ${Math.round((Date.now() - t0) / 60000)} min`)
  return { waitedMs: Date.now() - t0, free }
}
const require = createRequire(`${APP_ROOT}/package.json`)

/**
 * Ambiente da instância: o do processo sem as variáveis CLAUDE_ e ANTHROPIC_, mais a
 * pasta de dados e os ganchos de dev. As pastas do usuário (HOME, USERPROFILE, APPDATA,
 * LOCALAPPDATA, TEMP) apontam para dentro da rodada: `~`, `$env:APPDATA` e o `%TEMP%`
 * dos comandos do agente caem lá, não nos dados reais nem no rascunho de outra rodada.
 * O CLI continua com o login de sempre por CLAUDE_CONFIG_DIR = ~/.claude real.
 */
export function isolatedEnv(dataDir, base = process.env, realHome = base.USERPROFILE ?? base.HOME ?? '') {
  const env = {}
  for (const [k, v] of Object.entries(base)) {
    if (/^(CLAUDE|ANTHROPIC)/i.test(k) || k === 'ELECTRON_RUN_AS_NODE') continue
    env[k] = v
  }
  const user = path.join(dataDir, 'perfil')
  const dirs = {
    HOME: user,
    USERPROFILE: user,
    APPDATA: path.join(user, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(user, 'AppData', 'Local'),
    TEMP: path.join(user, 'AppData', 'Local', 'Temp'),
    TMP: path.join(user, 'AppData', 'Local', 'Temp')
  }
  return {
    ...env,
    ...dirs,
    AGENT_CODE_DEV_DATA_DIR: dataDir,
    AGENT_CODE_DEV_HOOKS: '1',
    // 24 núcleos = 23 workers do vitest por padrão: com o PC do usuário já carregado,
    // isso esgota a memória e derruba processos dele. Mesmo limite nos dois lados.
    VITEST_MAX_WORKERS: VITEST_WORKERS,
    ...(realHome ? { CLAUDE_CONFIG_DIR: path.join(realHome, '.claude'), PLAYWRIGHT_BROWSERS_PATH: path.join(base.LOCALAPPDATA ?? path.join(realHome, 'AppData', 'Local'), 'ms-playwright') } : {})
  }
}

/** Pasta de cache da instância (skills, planejamentos, memórias): <dados>/agent-code. */
export const cacheDirOf = (dataDir) => path.join(dataDir, 'agent-code')

/** Skills dos kits do app (ciclo, ECC): só entram pelo interruptor, nunca pela cópia das skills do usuário. */
const kitSkillNames = () =>
  new Set(['skills-ciclo', 'skills-ecc'].flatMap((d) => (existsSync(path.join(APP_ROOT, '.agents', d)) ? readdirSync(path.join(APP_ROOT, '.agents', d)) : [])))

/** Prepara a pasta de dados: skills do usuário (como no app dele, sem as dos kits) e o plano congelado. */
export function seedDataDir(dataDir, { userSkillsDir, plan }) {
  const cache = cacheDirOf(dataDir)
  mkdirSync(cache, { recursive: true })
  if (userSkillsDir && existsSync(userSkillsDir)) {
    const kit = kitSkillNames()
    for (const name of readdirSync(userSkillsDir)) {
      const src = path.join(userSkillsDir, name)
      if (!kit.has(name) && existsSync(path.join(src, 'SKILL.md'))) cpSync(src, path.join(cache, 'skills', name), { recursive: true })
    }
  }
  if (plan) cpSync(plan.from, path.join(cache, 'planning', plan.projectKey, plan.slug), { recursive: true })
}

/** Abre a instância e devolve { app, page, bridge }. */
export async function launch(dataDir, { log = console.log } = {}) {
  const { _electron } = require('playwright')
  const env = isolatedEnv(dataDir)
  for (const k of ['APPDATA', 'LOCALAPPDATA', 'TEMP']) mkdirSync(env[k], { recursive: true })
  const app = await _electron.launch({
    executablePath: path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: ['.'],
    cwd: APP_ROOT,
    env,
    timeout: 180_000
  })
  const page = await rendererPage(app)
  page.setDefaultTimeout(20_000)
  page.on('dialog', (d) => void d.accept().catch(() => undefined))
  const info = await app.evaluate(async () => globalThis.__agentCodeDev?.startPhoneBridge?.())
  if (!info?.port || !info?.token) throw new Error(`ponte do celular não subiu: ${JSON.stringify(info)}`)
  log(`[instância] ponte em 127.0.0.1:${info.port}`)
  const bridge = bridgeClient(`http://127.0.0.1:${info.port}`, info.token)
  app.stopListening = bridge.listen()
  await waitPublished(bridge)
  return { app, page, bridge }
}

/** Espera a tela começar a publicar o estado para a ponte (cliente SSE conectado). */
async function waitPublished(bridge, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = await bridge.state().catch(() => ({}))
    // O catálogo de modelos só chega pela publicação da tela (vale mesmo sem conversas).
    if ((Array.isArray(s.models) && s.models.length > 0) || (Array.isArray(s.conversations) && s.conversations.length > 0)) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('a tela não publicou o estado para a ponte (SSE sem cliente?)')
}

async function rendererPage(app) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const page = app.windows().find((w) => w.url().includes('out/renderer'))
    if (page) {
      await page.waitForLoadState('domcontentloaded')
      return page
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('janela do renderer não apareceu')
}

/** Cliente da ponte do celular (mesmas rotas do APK). */
export function bridgeClient(base, token) {
  const url = (p, q = {}) => `${base}${p}?${new URLSearchParams({ token, ...q })}`
  const json = async (res) => {
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      return { error: text }
    }
  }
  const post = async (p, body) => json(await fetch(url(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
  return {
    /**
     * Mantém um cliente no SSE /api/events. A tela só publica o estado para a ponte
     * com um celular conectado (`phoneLinked` = ponte no ar e clientes > 0): sem isso,
     * /api/state não traz conversas nem permissões pendentes. Devolve o desligar.
     */
    listen: () => {
      const ac = new AbortController()
      void (async () => {
        while (!ac.signal.aborted) {
          try {
            const res = await fetch(url('/api/events'), { signal: ac.signal })
            const reader = res.body.getReader()
            while (!(await reader.read()).done) {
              /* só manter a conexão */
            }
          } catch {
            /* caiu: tenta de novo */
          }
          if (!ac.signal.aborted) await new Promise((r) => setTimeout(r, 2000))
        }
      })()
      return () => ac.abort()
    },
    state: async () => json(await fetch(url('/api/state'))),
    history: async (convId) => json(await fetch(url('/api/history', { conv: convId }))),
    send: (convId, text) => post('/api/send', { convId, text }),
    setModel: (convId, model, effort) => post('/api/set-model', { convId, model, effort }),
    createConversation: (cwd) => post('/api/conversation', { type: 'create', cwd }),
    respond: (convId, res) => post('/api/permission-respond', { convId, ...res }),
    createPlan: (cwd, pedido) => post('/api/planning/create', { cwd, pedido })
  }
}

/** Configura o lado da rodada (interruptores), o modelo do Manager e desliga o que não é testado. */
export async function configure(page, { side, manager }) {
  await page.evaluate(
    (patch) => window.api.setConfig(patch),
    {
      handoff: { ciclo: side.ciclo, leituraGuiada: side.leituraGuiada },
      skillCatalog: { tiered: side.tiered },
      planning: { model: manager.model, effort: manager.effort },
      // Iguais nos dois lados e fora do teste: PO, vigia, memorista e TypeSafe gastam conta e mexem no quadro.
      board: { po: { enabled: false } },
      vigia: { enabled: false },
      memorista: { enabled: false },
      typesafe: { enabled: false }
    }
  )
  const cfg = await page.evaluate(() => window.api.getConfig())
  const got = { ciclo: cfg.handoff?.ciclo, leituraGuiada: cfg.handoff?.leituraGuiada, tiered: cfg.skillCatalog?.tiered, planning: cfg.planning }
  if (got.ciclo !== side.ciclo || got.leituraGuiada !== side.leituraGuiada || got.tiered !== side.tiered) {
    throw new Error(`config não aplicou: ${JSON.stringify(got)}`)
  }
  return got
}

/** Abre `folder` como projeto (o seletor nativo de pasta é trocado no main por uma resposta fixa). */
export async function openProject(app, page, folder) {
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
  }, folder)
  await page.locator('button[title="Abrir pasta como projeto"]').first().click()
  await page.waitForTimeout(2500)
}

/** Fecha a instância e o PostgreSQL dela; encerra o que sobrar com a pasta de dados na linha de comando. */
export async function shutdown(app, dataDir, { log = console.log } = {}) {
  app.stopListening?.()
  // A pasta de dados vai no ambiente, não na linha de comando: o processo principal
  // só é achado pelo PID que o Playwright devolve. Mata a árvore dele se o close falhar.
  const pid = app.process?.()?.pid
  // Descendentes ANTES de fechar: depois a árvore se perde (vitest/tsc/build que o
  // agente deixou rodando não têm a pasta de dados na linha de comando).
  const descendants = pid ? descendantPids(pid) : []
  await Promise.race([app.close().catch(() => undefined), new Promise((r) => setTimeout(r, 30_000))])
  // O PostgreSQL da instância para pelo pg_ctl (limpo) antes de matar o que sobrou da árvore.
  const pgdata = findPgData(dataDir)
  if (pgdata) {
    try {
      execFileSync(path.join(APP_ROOT, 'out', 'postgres', 'bin', 'pg_ctl.exe'), ['stop', '-D', pgdata, '-m', 'fast', '-w'], { stdio: 'ignore' })
    } catch {
      /* já parado */
    }
  }
  for (const p of [pid, ...descendants].filter(Boolean)) {
    try {
      execFileSync('taskkill', ['/PID', String(p), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* já saiu */
    }
  }
  const marker = dataDir.replace(/'/g, "''")
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' })
  } catch {
    /* nada sobrou */
  }
  log(`[instância] fechada (${descendants.length} processos descendentes encerrados)`)
}

/** PIDs de todos os descendentes de `root` (busca por ParentProcessId). */
function descendantPids(root) {
  try {
    const json = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const all = JSON.parse(json)
    const kids = new Map()
    for (const p of all) kids.set(p.ParentProcessId, [...(kids.get(p.ParentProcessId) ?? []), p.ProcessId])
    const out = []
    const queue = [root]
    while (queue.length) for (const k of kids.get(queue.shift()) ?? []) if (!out.includes(k)) out.push(k), queue.push(k)
    return out
  } catch {
    return []
  }
}

function findPgData(dir, depth = 0) {
  if (depth > 4 || !existsSync(dir)) return null
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const p = path.join(dir, e.name)
    if (e.name === 'pgdata' && existsSync(path.join(p, 'PG_VERSION'))) return p
    const found = findPgData(p, depth + 1)
    if (found) return found
  }
  return null
}
