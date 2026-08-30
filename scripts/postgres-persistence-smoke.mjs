import { _electron as electron } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'

const root = process.cwd()
const sandbox = await mkdtemp(join(tmpdir(), 'agent-code-postgres-smoke-'))
const home = join(sandbox, 'home')
const cache = join(sandbox, 'cache', 'agent-code')
const userData = join(sandbox, 'user-data')
const shots = join(sandbox, 'shots')
const missingProject = join(sandbox, 'project-that-was-moved')
for (const dir of [home, cache, userData, shots, join(cache, 'data'), join(home, '.agent-code')]) await mkdir(dir, { recursive: true })
await writeFile(join(home, '.agent-code', 'location.json'), JSON.stringify({ cacheDir: cache }), 'utf8')

const db = new DatabaseSync(join(cache, 'agent-code.db'))
try {
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.prepare('INSERT INTO kv(key, value) VALUES(?, ?)').run('config', JSON.stringify({
    openai: { apiKey: '', voice: 'alloy', speed: 1 },
    transcribeEngine: 'cloud',
    localSpeech: { model: 'nvidia/parakeet-tdt-0.6b-v3' },
    ollama: { enabled: false, apiKey: '' },
    skipPermissions: false,
    windowsControlEnabled: false,
    remoteToken: '',
    remoteEnabled: false
  }))
} finally { db.close() }
const projectDb = new DatabaseSync(join(cache, 'data', 'legacy.db'))
try {
  projectDb.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  projectDb.prepare('INSERT INTO kv(key, value) VALUES(?, ?)').run('conversations', JSON.stringify([
    {
      id: 'postgres-smoke',
      title: 'Antes da migração',
      cwd: root,
      model: 'claude-opus-5',
      sdkSessionId: null,
      messages: [{ type: 'user', content: 'payload legado com NUL\0preservado' }],
      tokens: { context: 0, output: 0, cost: 0 },
      createdAt: 1,
      updatedAt: 2
    },
    {
      id: 'postgres-missing-project-smoke',
      title: 'Projeto legado movido',
      cwd: missingProject,
      model: 'claude-opus-5',
      sdkSessionId: null,
      messages: [],
      tokens: { context: 0, output: 0, cost: 0 },
      createdAt: 0,
      updatedAt: 0
    }
  ]))
} finally { projectDb.close() }

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(sandbox, 'appdata'),
  LOCALAPPDATA: join(sandbox, 'localappdata')
}
delete env.ELECTRON_RUN_AS_NODE

function assert(condition, message) { if (!condition) throw new Error(message) }

async function launch(instanceUserData = userData, instanceEnv = env) {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${instanceUserData}`], cwd: root, env: instanceEnv, timeout: 30_000 })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => Boolean(window.api), null, { timeout: 15_000 })
  return { app, win }
}

async function close(running) {
  const result = await Promise.race([
    running.app.close().then(() => 'closed'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 15_000))
  ])
  if (result !== 'closed') {
    running.app.process().kill()
    throw new Error('Electron did not finish the durability close handshake')
  }
}

async function openPostgresSettings(win) {
  await win.locator('.settings-btn').click()
  const section = win.locator('.postgres-settings')
  await section.waitFor({ state: 'visible' })
  return section
}

let running = await launch()
let second = null
let postgresPaused = false
try {
  await running.win.waitForFunction(() => document.querySelectorAll('.conv-row').length >= 1, null, { timeout: 15_000 }).catch(async (error) => {
    const state = await running.win.evaluate(async () => ({
      body: document.body.innerText.slice(0, 2_000),
      status: await window.api.getStorageStatus().catch((cause) => ({ error: String(cause) })),
      conversations: await window.api.loadVersionedConversations().catch((cause) => ({ error: String(cause) }))
    }))
    throw new Error(`Initial renderer did not hydrate: ${JSON.stringify(state)}`, { cause: error })
  })
  let section = await openPostgresSettings(running.win)
  const fields = section.locator('input.settings-input')
  await fields.nth(0).fill(process.env.AGENT_CODE_PG_HOST ?? '127.0.0.1')
  await fields.nth(1).fill(process.env.AGENT_CODE_PG_PORT ?? '55432')
  await fields.nth(2).fill(process.env.AGENT_CODE_PG_USER ?? 'postgres')
  await fields.nth(3).fill(process.env.AGENT_CODE_PG_PASSWORD ?? 'agent-code-test-password')
  await fields.nth(4).fill(process.env.AGENT_CODE_PG_MAINTENANCE_DB ?? 'postgres')
  await section.getByRole('button', { name: 'Testar conexão' }).click()
  await running.win.getByText('Conexão PostgreSQL validada. Nenhum backend foi alterado.').waitFor()
  assert((await running.win.evaluate(() => window.api.getStorageStatus())).backend === 'sqlite', 'test changed backend')

  const reloaded = running.win.waitForEvent('domcontentloaded')
  await section.getByRole('button', { name: 'Ativar e migrar' }).click()
  await reloaded
  await running.win.waitForFunction(() => Boolean(window.api))
  await running.win.waitForFunction(async () => (await window.api.getStorageStatus()).state === 'postgres-ready')
  const active = await running.win.evaluate(async () => ({
    status: await window.api.getStorageStatus(),
    conversations: await window.api.loadVersionedConversations(),
    settings: await window.api.getPostgresSettings()
  }))
  assert(active.status.backend === 'postgres' && active.status.writable, 'PostgreSQL was not selected')
  assert(active.settings.hasPassword === true && !('password' in active.settings), 'password leaked or was not retained')
  assert(active.conversations.some((record) => record.id === 'postgres-smoke'), 'primary conversation was not migrated to PostgreSQL')
  assert(
    active.conversations.some((record) => record.id === 'postgres-missing-project-smoke'),
    'legacy missing-project conversation was not migrated to PostgreSQL'
  )
  await running.win.evaluate(async () => {
    const id = 'postgres-partial-payload-smoke'
    const current = (await window.api.loadVersionedConversations()).find((record) => record.id === id)
    await window.api.upsertConversation({
      id,
      ...(current ? { expectedRevision: current.revision } : {}),
      payload: { id, title: 'Registro legado parcial' }
    })
  })
  const partialReload = running.win.waitForEvent('domcontentloaded')
  await running.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F5' })
  })
  await partialReload
  await running.win.waitForFunction(() => Boolean(window.api))
  await running.win.waitForFunction(async () =>
    (await window.api.loadVersionedConversations())
      .some((record) => record.id === 'postgres-partial-payload-smoke')
  )
  await running.win.waitForFunction(() =>
    document.querySelectorAll('.conv-row').length >= 3 &&
    !document.body.innerText.includes('Persistência indisponível')
  )
  const manifests = await readdir(join(cache, 'migration-manifests'), { recursive: true })
  assert(manifests.some((entry) => String(entry).endsWith('manifest.json')), 'SQLite transition manifest was not created')
  await running.win.screenshot({ path: join(shots, 'postgres-ready.png') })

  const secondHome = join(sandbox, 'home-second')
  const secondCache = join(sandbox, 'cache-second', 'agent-code')
  const secondUserData = join(sandbox, 'user-data-second')
  for (const dir of [secondHome, secondCache, secondUserData, join(secondHome, '.agent-code')]) {
    await mkdir(dir, { recursive: true })
  }
  await writeFile(join(secondHome, '.agent-code', 'location.json'), JSON.stringify({ cacheDir: secondCache }), 'utf8')
  const secondEnv = {
    ...env,
    HOME: secondHome,
    USERPROFILE: secondHome,
    APPDATA: join(sandbox, 'appdata-second'),
    LOCALAPPDATA: join(sandbox, 'localappdata-second')
  }
  second = await launch(secondUserData, secondEnv)
  const secondSection = await openPostgresSettings(second.win)
  const secondFields = secondSection.locator('input.settings-input')
  await secondFields.nth(0).fill(process.env.AGENT_CODE_PG_HOST ?? '127.0.0.1')
  await secondFields.nth(1).fill(process.env.AGENT_CODE_PG_PORT ?? '55432')
  await secondFields.nth(2).fill(process.env.AGENT_CODE_PG_USER ?? 'postgres')
  await secondFields.nth(3).fill(process.env.AGENT_CODE_PG_PASSWORD ?? 'agent-code-test-password')
  await secondFields.nth(4).fill(process.env.AGENT_CODE_PG_MAINTENANCE_DB ?? 'postgres')
  const secondActivated = second.win.waitForEvent('domcontentloaded')
  await secondSection.getByRole('button', { name: 'Ativar e migrar' }).click()
  await secondActivated
  await second.win.waitForFunction(() => Boolean(window.api))
  await second.win.waitForFunction(async () => (await window.api.getStorageStatus()).state === 'postgres-ready')
  const secondRecord = await second.win.evaluate(async () => {
    try {
      return (await window.api.loadVersionedConversations()).find((record) => record.id === 'postgres-smoke')
    } catch (error) {
      throw new Error(JSON.stringify({
        message: String(error),
        status: await window.api.getStorageStatus(),
        body: document.body.innerText.slice(0, 2_000)
      }))
    }
  })
  assert(secondRecord.payload.cwd === '', 'local project path leaked to a second installation')
  await second.win.evaluate(async ({ cwd }) => {
    const record = (await window.api.loadVersionedConversations()).find((item) => item.id === 'postgres-smoke')
    if (!record) throw new Error('primary fixture missing on second installation')
    await window.api.upsertConversation({
      id: record.id,
      expectedRevision: record.revision,
      payload: { ...record.payload, cwd }
    })
  }, { cwd: root })
  const secondReloaded = second.win.waitForEvent('domcontentloaded')
  await second.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F5' })
  })
  await secondReloaded
  await second.win.waitForFunction(() => Boolean(window.api))
  await second.win.evaluate(async () => {
    const record = (await window.api.loadVersionedConversations()).find((item) => item.id === 'postgres-smoke')
    if (!record) throw new Error('primary fixture missing before remote update')
    await window.api.upsertConversation({
      id: record.id,
      expectedRevision: record.revision,
      payload: { ...record.payload, title: 'Sincronizada entre instalações' }
    })
  })
  await running.win.waitForFunction(async () =>
    (await window.api.loadVersionedConversations())
      .some((record) => record.id === 'postgres-smoke' && record.payload.title === 'Sincronizada entre instalações')
  )
  await close(second)
  second = null

  await running.win.evaluate(async () => {
    const record = (await window.api.loadVersionedConversations()).find((item) => item.id === 'postgres-smoke')
    if (!record) throw new Error('primary fixture missing before local update')
    await window.api.upsertConversation({
      id: record.id,
      expectedRevision: record.revision,
      payload: { ...record.payload, title: 'Persistida no PostgreSQL' }
    })
  })
  await running.win.waitForFunction(async () =>
    (await window.api.loadVersionedConversations())
      .some((record) => record.id === 'postgres-smoke' && record.payload.title === 'Persistida no PostgreSQL')
  )
  const legacyMissingResult = await running.win.evaluate(async ({ missingProject }) => {
    const records = await window.api.loadVersionedConversations()
    const legacy = records.find((record) => record.id === 'postgres-missing-project-smoke')
    if (!legacy) throw new Error('missing legacy fixture')
    const stored = await window.api.upsertConversation({
      id: legacy.id,
      expectedRevision: legacy.revision,
      payload: { ...legacy.payload, title: 'Histórico salvo mesmo após mover a pasta' }
    })
    let rejectedNewInvalidPath = false
    try {
      await window.api.upsertConversation({
        id: 'postgres-new-invalid-project-smoke',
        payload: { id: 'postgres-new-invalid-project-smoke', cwd: missingProject, title: 'Inválida' }
      })
    } catch {
      rejectedNewInvalidPath = true
    }
    return { stored, rejectedNewInvalidPath }
  }, { missingProject })
  assert(legacyMissingResult.stored.payload.title === 'Histórico salvo mesmo após mover a pasta', 'legacy missing cwd was not updated')
  assert(legacyMissingResult.rejectedNewInvalidPath, 'new conversation accepted an invalid project path')
  await close(running)
  running = await launch()
  await running.win.waitForFunction(async () =>
    (await window.api.loadVersionedConversations())
      .some((record) => record.id === 'postgres-smoke' && record.payload.title === 'Persistida no PostgreSQL')
  )
  assert((await running.win.evaluate(() => window.api.getStorageStatus())).backend === 'postgres', 'restart lost backend')
  assert(await running.win.evaluate(async () =>
    (await window.api.loadVersionedConversations())
      .some((record) => record.id === 'postgres-missing-project-smoke' &&
        record.payload.title === 'Histórico salvo mesmo após mover a pasta')
  ), 'legacy missing cwd update was lost after restart')

  if (process.env.AGENT_CODE_PG_OUTAGE_TEST === '1') {
    await close(running)
    execFileSync('docker', ['pause', process.env.AGENT_CODE_PG_CONTAINER ?? 'agent-code-pg16-tests'])
    postgresPaused = true
    running = await launch()
    await running.win.getByText('Persistência indisponível').waitFor({ timeout: 20_000 })
    const offline = await running.win.evaluate(() => window.api.getStorageStatus())
    assert(offline.backend === 'postgres' && offline.state === 'postgres-offline', 'outage fell back from PostgreSQL')
    assert(await running.win.evaluate(() => document.querySelector('.conv-row') === null), 'renderer unexpectedly exposed conversation state while offline')
    await running.win.screenshot({ path: join(shots, 'postgres-offline.png') })
    execFileSync('docker', ['unpause', process.env.AGENT_CODE_PG_CONTAINER ?? 'agent-code-pg16-tests'])
    postgresPaused = false
    const recovered = running.win.waitForEvent('domcontentloaded')
    await running.win.getByRole('button', { name: 'Tentar novamente' }).click()
    await recovered
    await running.win.waitForFunction(async () => (await window.api.getStorageStatus()).state === 'postgres-ready')
    await running.win.waitForFunction(async () =>
      (await window.api.loadVersionedConversations())
        .some((record) => record.id === 'postgres-smoke' && record.payload.title === 'Persistida no PostgreSQL')
    )
  }

  await running.win.evaluate(() => window.api.deactivatePostgres())
  const sqliteReload = running.win.waitForEvent('domcontentloaded')
  await running.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F5' })
  })
  await sqliteReload
  await running.win.waitForFunction(async () => (await window.api.getStorageStatus()).state === 'sqlite-ready')
  const deactivated = await running.win.evaluate(async () => ({
    status: await window.api.getStorageStatus(),
    conversations: await window.api.loadVersionedConversations()
  }))
  assert(deactivated.status.backend === 'sqlite', 'SQLite was not restored')
  assert(deactivated.conversations.some((entry) => entry.payload.title === 'Persistida no PostgreSQL'), 'round-trip lost conversation')
  await running.win.screenshot({ path: join(shots, 'sqlite-restored.png') })
} finally {
  if (postgresPaused) {
    try { execFileSync('docker', ['unpause', process.env.AGENT_CODE_PG_CONTAINER ?? 'agent-code-pg16-tests']) } catch {}
  }
  if (second) await close(second).catch(() => second.app.process().kill())
  await close(running).catch(() => running.app.process().kill())
}

const report = JSON.stringify({ ok: true, sandbox, shots }, null, 2)
await new Promise((resolve, reject) => {
  process.stdout.write(`${report}\n`, (error) => error ? reject(error) : resolve())
})
process.exit(0)
