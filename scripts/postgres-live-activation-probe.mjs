import { _electron as electron } from 'playwright'

const root = process.cwd()
const userData = process.env.AGENT_CODE_DIAGNOSTIC_USER_DATA
if (!userData) throw new Error('AGENT_CODE_DIAGNOSTIC_USER_DATA is required')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

function sanitized(error) {
  return String(error)
    .replace(/password=[^\s]+/gi, 'password=[redacted]')
    .replace(/Error invoking remote method '[^']+':\s*/i, '')
    .slice(0, 2_000)
}

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userData}`],
  cwd: root,
  env,
  timeout: 30_000
})
const diagnostics = []
app.process().stderr?.on('data', (chunk) => {
  const text = String(chunk)
  if (text.includes('[storage-transition]')) diagnostics.push(...text.split(/\r?\n/).filter((line) => line.includes('[storage-transition]')))
})
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await win.waitForFunction(() => Boolean(window.api), null, { timeout: 15_000 })
const report = await win.evaluate(async () => {
  const before = await window.api.getStorageStatus()
  const settings = await window.api.getPostgresSettings()
  const draft = { ...settings, password: '' }
  let test = 'passed'
  let activation = 'passed'
  try {
    await window.api.testPostgresConnection(draft)
  } catch (error) {
    test = String(error)
  }
  if (test === 'passed') {
    try {
      await window.api.activatePostgres(draft)
    } catch (error) {
      activation = String(error)
    }
  }
  let conversations
  try {
    conversations = (await window.api.loadVersionedConversations()).length
  } catch (error) {
    conversations = String(error)
  }
  return {
    before,
    test,
    activation,
    after: await window.api.getStorageStatus(),
    conversations
  }
})
await new Promise((resolve) => setTimeout(resolve, 100))
report.diagnostics = diagnostics
report.test = report.test === 'passed' ? 'passed' : sanitized(report.test)
report.activation = report.activation === 'passed' ? 'passed' : sanitized(report.activation)
if (typeof report.conversations === 'string') report.conversations = sanitized(report.conversations)
console.log(JSON.stringify(report, null, 2))
await app.close()
