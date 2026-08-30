import { _electron as electron } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const sandbox = await mkdtemp(join(tmpdir(), 'agent-code-sqlite-v2-smoke-'))
const home = join(sandbox, 'home')
const cache = join(sandbox, 'cache', 'agent-code')
const userData = join(sandbox, 'user-data')
const shots = join(sandbox, 'shots')
for (const dir of [home, cache, userData, shots, join(cache, 'data'), join(home, '.agent-code')]) {
  await mkdir(dir, { recursive: true })
}
await writeFile(join(home, '.agent-code', 'location.json'), JSON.stringify({ cacheDir: cache }), 'utf8')

function seedKv(path, rows) {
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const insert = db.prepare('INSERT INTO kv(key, value) VALUES(?, ?)')
    for (const [key, value] of Object.entries(rows)) insert.run(key, value)
  } finally {
    db.close()
  }
}

seedKv(join(cache, 'agent-code.db'), {
  config: JSON.stringify({
    openai: { apiKey: '', voice: 'alloy', speed: 1 },
    transcribeEngine: 'cloud',
    localSpeech: { model: 'nvidia/parakeet-tdt-0.6b-v3' },
    ollama: { enabled: false, apiKey: '' },
    skipPermissions: false,
    windowsControlEnabled: false,
    remoteToken: '',
    remoteEnabled: false
  })
})
seedKv(join(cache, 'data', 'legacy.db'), {
  conversations: JSON.stringify([
    {
      id: 'legacy',
      title: 'Conversa legada',
      cwd: root,
      model: 'claude-opus-5',
      sdkSessionId: null,
      messages: [],
      tokens: { context: 0, output: 0, cost: 0 },
      createdAt: 1,
      updatedAt: 2
    }
  ])
})

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(sandbox, 'appdata'),
  LOCALAPPDATA: join(sandbox, 'localappdata')
}
delete env.ELECTRON_RUN_AS_NODE

async function launch() {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root, env, timeout: 30_000 })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => Boolean(window.api), null, { timeout: 15_000 })
  return { app, win }
}

async function closeApp(running, label) {
  console.log(`[smoke] closing ${label}`)
  const result = await Promise.race([
    running.app.close().then(() => 'closed'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 10_000))
  ])
  if (result === 'timeout') {
    const state = await running.win
      .evaluate(() => ({ body: document.body.innerText.slice(0, 500) }))
      .catch((error) => ({ error: String(error) }))
    running.app.process().kill()
    throw new Error(`close handshake timed out: ${JSON.stringify(state)}`)
  }
  console.log(`[smoke] closed ${label}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

let running = await launch()
try {
  await running.win.waitForSelector('.conv-row', { timeout: 15_000 })
  const migrated = await running.win.evaluate(() => window.api.loadAllConversations())
  assert(migrated.length === 1 && migrated[0].id === 'legacy', 'legacy conversation was not migrated')

  await running.win.evaluate(() => window.api.setConfig({ skipPermissions: true }))
  const addResult = await running.win.evaluate(() => {
    const button = document.querySelector('.project-add')
    if (!(button instanceof HTMLElement)) return false
    button.click()
    return true
  })
  assert(addResult, 'project add button was not found')
  await running.win.waitForTimeout(1_000)
  const afterAdd = await running.win.evaluate(() => ({
    count: document.querySelectorAll('.project-convs .conv-row').length,
    titles: [...document.querySelectorAll('.project-convs .conv-title')].map((item) => item.textContent),
    text: document.body.innerText.slice(0, 1_000)
  }))
  assert(afterAdd.count === 2, `new conversation was not rendered: ${JSON.stringify(afterAdd)}`)

  const rows = running.win.locator('.project-convs .conv-row')
  const createdRow = rows.filter({ hasNotText: 'Conversa legada' }).first()
  await createdRow.click({ clickCount: 2, delay: 80 })
  const edit = createdRow.locator('.conv-rename')
  await edit.fill('Conversa editada')
  await edit.press('Enter')
  await running.win.waitForFunction(() =>
    [...document.querySelectorAll('.conv-title')].some((item) => item.textContent === 'Conversa editada')
  )
  // F5 is also a durability boundary. Change the title inside the debounce,
  // reload immediately, and require the re-mounted renderer to read it back.
  await createdRow.click({ clickCount: 2, delay: 80 })
  const reloadEdit = createdRow.locator('.conv-rename')
  await reloadEdit.fill('Conversa recarregada')
  await reloadEdit.press('Enter')
  const reloaded = running.win.waitForEvent('domcontentloaded')
  await running.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F5' })
  })
  await reloaded
  await running.win.waitForFunction(() => Boolean(window.api), null, { timeout: 15_000 })
  await running.win.waitForFunction(() =>
    [...document.querySelectorAll('.conv-title')].some((item) => item.textContent === 'Conversa recarregada')
  )

  const reloadedCreatedRow = running.win.locator('.project-convs .conv-row').filter({ hasNotText: 'Conversa legada' }).first()
  await reloadedCreatedRow.click({ clickCount: 2, delay: 80 })
  const reloadedEdit = reloadedCreatedRow.locator('.conv-rename')
  await reloadedEdit.fill('Conversa editada')
  await reloadedEdit.press('Enter')
  await running.win.waitForFunction(() =>
    [...document.querySelectorAll('.conv-title')].some((item) => item.textContent === 'Conversa editada')
  )
  // Close immediately inside the 400 ms debounce window. The main/renderer
  // handshake must flush the rename before Playwright sees the process exit.
  await closeApp(running, 'inside debounce')
  running = await launch()
  await running.win.waitForFunction(() =>
    [...document.querySelectorAll('.conv-title')].some((item) => item.textContent === 'Conversa editada')
  )
  const afterEdit = await running.win.evaluate(async () => ({
    conversations: await window.api.loadAllConversations(),
    config: await window.api.getConfig()
  }))
  assert(afterEdit.conversations.length === 2, 'create/list did not survive immediate close')
  assert(afterEdit.conversations.some((item) => item.title === 'Conversa editada'), 'edit did not survive close')
  assert(afterEdit.config.skipPermissions === true, 'configuration did not persist')
  await running.win.screenshot({ path: join(shots, 'sqlite-v2-populated.png') })

  const reopenedRows = running.win.locator('.project-convs .conv-row')
  const legacyRow = reopenedRows.filter({ hasText: 'Conversa legada' }).first()
  await legacyRow.locator('.conv-del').evaluate((button) => button.click())
  await running.win.locator('.modal-actions .danger-btn').click()
  await running.win.waitForFunction(() => document.querySelectorAll('.project-convs .conv-row').length === 1)
  await running.win.waitForTimeout(700)
  const afterDelete = await running.win.evaluate(() => window.api.loadAllConversations())
  assert(afterDelete.length === 1 && afterDelete[0].title === 'Conversa editada', 'delete did not persist')

  await running.win.locator('.project-convs .conv-row .conv-del').evaluate((button) => button.click())
  await running.win.locator('.modal-actions .danger-btn').click()
  await running.win.waitForFunction(() => document.querySelectorAll('.project-convs .conv-row').length === 0)
  await running.win.waitForTimeout(700)
  const empty = await running.win.evaluate(() => window.api.loadAllConversations())
  assert(empty.length === 0, 'empty state did not persist')
  await running.win.screenshot({ path: join(shots, 'sqlite-v2-empty.png') })
} finally {
  await closeApp(running, 'first flow').catch(() => running.app.process().kill())
}

running = await launch()
try {
  const reloaded = await running.win.evaluate(async () => ({
    conversations: await window.api.loadAllConversations(),
    config: await window.api.getConfig()
  }))
  assert(reloaded.conversations.length === 0, 'empty state resurrected after app restart')
  assert(reloaded.config.skipPermissions === true, 'config was lost after app restart')
} finally {
  await closeApp(running, 'restart verification')
}

const db = new DatabaseSync(join(cache, 'agent-code.db'), { readOnly: true })
try {
  const migration = db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get()
  const tombstones = db.prepare('SELECT COUNT(*) AS count FROM conversations_v2 WHERE deleted_at IS NOT NULL').get()
  assert(migration?.version === 1, 'SQLite v2 migration marker is missing')
  assert(Number(tombstones?.count ?? 0) === 2, 'conversation tombstones were not retained')
} finally {
  db.close()
}

console.log(JSON.stringify({ ok: true, sandbox, shots }, null, 2))
