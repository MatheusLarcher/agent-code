import { _electron as electron } from 'playwright'

const root = process.cwd()
const userData = process.env.AGENT_CODE_DIAGNOSTIC_USER_DATA
if (!userData) throw new Error('AGENT_CODE_DIAGNOSTIC_USER_DATA is required')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

async function launch() {
  const diagnostics = []
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root, env, timeout: 30_000 })
  app.process().stderr?.on('data', (chunk) => {
    const value = String(chunk)
    if (value.includes("handler for 'conversations:upsert'")) diagnostics.push(value.trim())
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => Boolean(window.api), null, { timeout: 15_000 })
  await win.waitForFunction(async () => (await window.api.getStorageStatus()).state === 'postgres-ready')
  return { app, win, diagnostics }
}

async function close(running) {
  const result = await Promise.race([
    running.app.close().then(() => 'closed'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 20_000))
  ])
  if (result !== 'closed') throw new Error('Electron did not complete the close flush handshake')
}

async function expandSidebar(win) {
  if (await win.locator('.sidebar.collapsed').isVisible().catch(() => false)) {
    await win.locator('.sidebar-collapse').click()
  }
}

async function renameVisibleConversation(win, title, nextTitle) {
  await expandSidebar(win)
  const row = win.getByTitle(`${title} — duplo-clique para renomear`).last()
  await row.waitFor({ state: 'visible' })
  await row.dblclick()
  const input = win.locator('.conv-rename').last()
  await input.fill(nextTitle)
  await input.press('Enter')
}

const toastText = 'Não foi possível salvar o histórico. A conversa continua marcada como não salva.'
const progress = (step) => process.stderr.write(`[history-probe] ${step}\n`)
let running = await launch()
let activeId
let originalTitle
let temporaryTitle
let restored = false
let report
try {
  progress('setup-start')
  const setup = await running.win.evaluate(async () => {
    const status = await window.api.getStorageStatus()
    const records = await window.api.loadVersionedConversations()
    const missing = records.filter((record) =>
      !record.deletedAt &&
      typeof record.payload.cwd === 'string' &&
      record.payload.cwd.length > 0 &&
      typeof record.payload.projectSignature !== 'string'
    )
    const ui = JSON.parse((await window.api.kvGet('agentcode.ui.v1')) || '{}')
    const active = records.find((record) => record.id === ui.activeId && !record.deletedAt) ??
      records.find((record) => !record.deletedAt)
    if (!active || typeof active.payload.title !== 'string') throw new Error('No active conversation available for UI save probe')
    return {
      backend: status.backend,
      missingCount: missing.length,
      activeId: active.id,
      title: active.payload.title
    }
  })
  progress('setup-complete')
  activeId = setup.activeId
  const visibleTitle = setup.title
  originalTitle = visibleTitle.replace(/(?: \[teste de persistência\])+$/, '')
  if (visibleTitle !== originalTitle) {
    await renameVisibleConversation(running.win, visibleTitle, originalTitle)
    await running.win.waitForFunction(async ({ activeId, originalTitle }) =>
      (await window.api.loadVersionedConversations())
        .some((record) => record.id === activeId && record.payload.title === originalTitle),
    { activeId, originalTitle })
    progress('prior-probe-title-cleaned')
  }
  temporaryTitle = `${originalTitle} [teste de persistência]`
  progress('rename-start')
  await renameVisibleConversation(running.win, originalTitle, temporaryTitle)
  await running.win.waitForFunction(async ({ activeId, temporaryTitle }) =>
    (await window.api.loadVersionedConversations())
      .some((record) => record.id === activeId && record.payload.title === temporaryTitle),
  { activeId, temporaryTitle })
  const toastAfterSave = await running.win.getByText(toastText, { exact: true }).isVisible().catch(() => false)
  progress('rename-persisted')

  const reloaded = running.win.waitForEvent('domcontentloaded')
  await running.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F5' })
  })
  await reloaded
  await running.win.waitForFunction(() => Boolean(window.api))
  const persistedAfterReload = await running.win.evaluate(async ({ activeId, temporaryTitle }) =>
    (await window.api.loadVersionedConversations())
      .some((record) => record.id === activeId && record.payload.title === temporaryTitle),
  { activeId, temporaryTitle })
  progress('reload-complete')

  await renameVisibleConversation(running.win, temporaryTitle, originalTitle)
  await running.win.waitForFunction(async ({ activeId, originalTitle }) =>
    (await window.api.loadVersionedConversations())
      .some((record) => record.id === activeId && record.payload.title === originalTitle),
  { activeId, originalTitle })
  restored = true
  progress('restore-complete')
  const toastAfterRestore = await running.win.getByText(toastText, { exact: true }).isVisible().catch(() => false)
  const firstDiagnostics = [...running.diagnostics]
  await close(running)

  running = await launch()
  progress('restart-complete')
  const restart = await running.win.evaluate(async ({ activeId, originalTitle }) => ({
    status: await window.api.getStorageStatus(),
    restored: (await window.api.loadVersionedConversations())
      .some((record) => record.id === activeId && record.payload.title === originalTitle)
  }), { activeId, originalTitle })
  report = {
    ok: setup.backend === 'postgres' &&
      setup.missingCount > 0 &&
      persistedAfterReload &&
      restart.status.backend === 'postgres' &&
      restart.restored &&
      !toastAfterSave &&
      !toastAfterRestore &&
      firstDiagnostics.length === 0,
    backend: setup.backend,
    missingCount: setup.missingCount,
    persistedAfterReload,
    toastAfterSave,
    toastAfterRestore,
    upsertDiagnostics: firstDiagnostics.length,
    restartBackend: restart.status.backend,
    restoredAfterRestart: restart.restored
  }
} finally {
  if (!restored && activeId && originalTitle) {
    await running.win.evaluate(async ({ activeId, originalTitle }) => {
      const record = (await window.api.loadVersionedConversations()).find((item) => item.id === activeId)
      if (record && record.payload.title !== originalTitle) {
        await window.api.upsertConversation({
          id: activeId,
          expectedRevision: record.revision,
          payload: { ...record.payload, title: originalTitle }
        })
      }
    }, { activeId, originalTitle }).catch(() => undefined)
  }
  await close(running).catch(() => running.app.process().kill())
}

if (!report?.ok) throw new Error(`Live history probe failed: ${JSON.stringify(report)}`)
await new Promise((resolve, reject) => {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, (error) => error ? reject(error) : resolve())
})
process.exit(0)
