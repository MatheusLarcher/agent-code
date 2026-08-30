import { randomUUID } from 'node:crypto'
import { _electron as electron } from 'playwright'

const root = process.cwd()
const userData = process.env.AGENT_CODE_DIAGNOSTIC_USER_DATA
if (!userData) throw new Error('AGENT_CODE_DIAGNOSTIC_USER_DATA is required')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const id = `postgres-live-proof-${randomUUID()}`

async function launch() {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root, env, timeout: 30_000 })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => Boolean(window.api), null, { timeout: 15_000 })
  await win.waitForFunction(async () => (await window.api.getStorageStatus()).state === 'postgres-ready')
  return { app, win }
}

async function close(running) {
  const result = await Promise.race([
    running.app.close().then(() => 'closed'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 20_000))
  ])
  if (result !== 'closed') throw new Error('Electron did not complete the close flush handshake')
}

let running = await launch()
const created = await running.win.evaluate(async ({ id, cwd }) => window.api.upsertConversation({
  id,
  payload: {
    id,
    title: 'Prova PostgreSQL antes do reinício',
    cwd,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}), { id, cwd: root })
const reload = running.win.waitForEvent('domcontentloaded')
await running.app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F5' })
})
await reload
await running.win.waitForFunction(() => Boolean(window.api))
const afterReload = await running.win.evaluate(async (id) => {
  const status = await window.api.getStorageStatus()
  const record = (await window.api.loadVersionedConversations()).find((item) => item.id === id)
  return { status, record }
}, id)
await close(running)

running = await launch()
const afterRestart = await running.win.evaluate(async (id) => {
  const status = await window.api.getStorageStatus()
  const record = (await window.api.loadVersionedConversations()).find((item) => item.id === id)
  return { status, record }
}, id)
const updated = await running.win.evaluate(async ({ id, revision, cwd }) => window.api.upsertConversation({
  id,
  expectedRevision: revision,
  payload: {
    id,
    title: 'Prova PostgreSQL depois do reinício',
    cwd,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}), { id, revision: afterRestart.record.revision, cwd: root })
const deleted = await running.win.evaluate(
  async ({ id, revision }) => window.api.deleteConversation({ id, expectedRevision: revision }),
  { id, revision: updated.revision }
)
await close(running)

const report = JSON.stringify({
  ok: true,
  id,
  createdRevision: created.revision,
  reloadBackend: afterReload.status.backend,
  reloadFound: afterReload.record?.id === id,
  restartBackend: afterRestart.status.backend,
  restartFound: afterRestart.record?.id === id,
  updatedRevision: updated.revision,
  tombstoneRevision: deleted.revision,
  tombstonePersisted: Boolean(deleted.deletedAt)
}, null, 2)
await new Promise((resolve, reject) => {
  process.stdout.write(`${report}\n`, (error) => error ? reject(error) : resolve())
})
// Playwright can retain a Windows pipe handle after Electron has closed. The
// proof is complete and stdout is flushed, so do not leave the probe hanging.
process.exit(0)
