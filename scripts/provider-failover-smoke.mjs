// Real Electron + renderer + IPC + SDK + SQLite. Only external provider replies
// and authentication are replaced in a disposable build, never in production.
import { build } from 'esbuild'
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const root = process.cwd()
const sandbox = await mkdtemp(join(tmpdir(), 'agent-failover-smoke-'))
const home = join(sandbox, 'home'), cache = join(sandbox, 'cache'), project = join(sandbox, 'project')
for (const dir of [join(home, '.agent-code'), join(cache, 'memories'), join(project, 'docs'), join(project, '.claude', 'skills', 'probe')]) await mkdir(dir, { recursive: true })
await writeFile(join(home, '.agent-code', 'location.json'), JSON.stringify({ cacheDir: cache }))
await writeFile(join(cache, 'memories', 'MEMORY.md'), '# Memory\nMEMORY_PARITY_SENTINEL\n')
await writeFile(join(project, 'docs', 'guide.md'), '# Guide\nDOC_PARITY_SENTINEL\n')
await writeFile(join(project, '.claude', 'skills', 'probe', 'SKILL.md'), '---\nname: probe\ndescription: SKILL_PARITY_SENTINEL\n---\nRead the project guide.\n')

let mode = 'claude-to-gpt'
let counts = { claude: 0, gpt: 0 }
const requests = []
const toolPath = join(project, 'result.txt')
function anthropic(res, content, stop = 'end_turn') {
  const msg = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 } }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  event('message_start', { message: { ...msg, content: [], stop_reason: null } })
  content.forEach((block, index) => {
    event('content_block_start', { index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } })
    event('content_block_delta', { index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    event('content_block_stop', { index })
  })
  event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: msg.usage })
  event('message_stop', {})
  res.end()
}
function gpt(res, content, tool) {
  const item = tool ? { type: 'function_call', id: `fc_${randomUUID()}`, call_id: `call_${randomUUID()}`, name: tool.name, arguments: JSON.stringify(tool.input), status: 'completed' }
    : { type: 'message', id: `msg_${randomUUID()}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content }] }
  const events = [{ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: `resp_${randomUUID()}`, status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 10 } } }]
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
}
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  if (!raw) { res.writeHead(200).end('{}'); return }
  const body = JSON.parse(raw)
  if (req.url?.includes('count_tokens')) { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"input_tokens":20}'); return }
  const provider = req.url === '/codex' ? 'gpt' : 'claude'
  // Ignore SDK background helpers when auditing the main user turn.
  if (!JSON.stringify(body).includes('USER_PARITY_SENTINEL') && !JSON.stringify(body).includes('PROVIDER_CONTINUATION')) {
    anthropic(res, [{ type: 'text', text: 'OK' }]); return
  }
  requests.push({ provider, mode, body })
  const n = ++counts[provider]
  const failing = mode === 'both' || (['claude-to-gpt', 'missing-auth'].includes(mode) && provider === 'claude') || (['gpt-to-claude', 'stop-switch'].includes(mode) && provider === 'gpt')
  if (failing && (mode === 'both' || n > 1)) {
    res.writeHead(provider === 'gpt' ? 429 : 400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code: 'insufficient_quota', message: 'Credit balance is too low. usage_limit_reached' } })); return
  }
  const tool = failing ? { name: 'Write', input: { file_path: toolPath, content: 'TOOL_RESULT_SENTINEL' } }
    : n === 1 ? { name: 'Read', input: { file_path: toolPath } } : null
  if (provider === 'gpt') gpt(res, 'CONTINUATION_COMPLETE', tool)
  else anthropic(res, tool ? [{ type: 'tool_use', id: `toolu_${randomUUID()}`, ...tool }] : [{ type: 'text', text: 'CONTINUATION_COMPLETE' }], tool ? 'tool_use' : 'end_turn')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const entry = resolve('out/main/provider-failover-smoke.mjs')
await build({
  entryPoints: ['src/main/index.ts'], outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external',
  plugins: [{ name: 'test-provider-boundary', setup(b) {
    b.onLoad({ filter: /[\\/]main[\\/](codexAuth|codexProxy|auth)\.ts$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8')
      if (path.endsWith('codexAuth.ts')) {
        contents = contents.replace('export function isCodexConnected(): boolean {', 'export function isCodexConnected(): boolean { return process.env.TEST_CODEX_CONNECTED !== "0";')
        contents = contents.replace('export function codexStatus(): { connected: boolean; accountId?: string; email?: string; planType?: string } {', 'export function codexStatus(): { connected: boolean; accountId?: string; email?: string; planType?: string } { return {connected:true};')
        contents = contents.replace('export async function getValidCodexTokens(): Promise<CodexTokens | null> {', 'export async function getValidCodexTokens(): Promise<CodexTokens | null> { return {accessToken:"test",refreshToken:"test",idToken:"test",accountId:"test",expiresAt:Date.now()+3600000};')
      } else if (path.endsWith('codexProxy.ts')) contents = contents.replace('https://chatgpt.com/backend-api/codex/responses', `http://127.0.0.1:${port}/codex`)
      else contents = contents.replace('export async function isAuthenticated(): Promise<boolean> {', 'export async function isAuthenticated(): Promise<boolean> { if(process.env.TEST_AUTH_DELAY === "1") { process.env.TEST_AUTH_STARTED = "1"; await new Promise(r => setTimeout(r, 1500)); } return true;')
      return { contents, loader: 'ts' }
    })
  } }]
})
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(sandbox, 'appdata'), LOCALAPPDATA: join(sandbox, 'localappdata'), CLAUDE_CONFIG_DIR: join(home, '.claude'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: 'test', ANTHROPIC_API_KEY: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' }
delete env.ELECTRON_RUN_AS_NODE
let app
try {
  app = await electron.launch({ args: [entry, `--user-data-dir=${join(sandbox, 'user-data')}`], cwd: root, env, timeout: 30000 })
  app.process().stderr.on('data', (chunk) => { const s = String(chunk); if (/error|failed/i.test(s)) console.log(s.slice(0, 500)) })
  const page = await app.firstWindow({ timeout: 20000 })
  page.on('dialog', (dialog) => { void dialog.accept().catch(() => {}) })
  await page.waitForFunction(() => Boolean(window.api), null, { timeout: 20000 })
  console.log('Electron opened', sandbox)
  // Seed a persisted conversation through the real API; use the UI for dispatch.
  const now = Date.now()
  await page.evaluate(async ({ project, now }) => {
    await window.api.saveAllConversations([{ id: 'quota-smoke', title: 'Quota smoke', cwd: project, model: 'claude-opus-5', messages: [], tokens: { context: 0, output: 0, cost: 0 }, createdAt: now, updatedAt: now }])
    localStorage.setItem('agentcode.ui.v1', JSON.stringify({ activeId: 'quota-smoke' }))
  }, { project, now })
  await page.reload()
  await page.waitForSelector('select.model-select')
  // Permit the synthetic file write; this scope contains only test files.
  const allow = page.getByTitle(/Permitir tudo|Allow all/i)
  if (await allow.count()) await allow.first().click()
  for (const direction of ['claude-to-gpt', 'gpt-to-claude', 'both', 'missing-auth', 'stop-switch']) {
    mode = direction; counts = { claude: 0, gpt: 0 }
    await app.evaluate((_, direction) => {
      process.env.TEST_CODEX_CONNECTED = direction === 'missing-auth' ? '0' : '1'
      process.env.TEST_AUTH_DELAY = direction === 'stop-switch' ? '1' : '0'
      process.env.TEST_AUTH_STARTED = '0'
    }, direction)
    const source = ['gpt-to-claude', 'stop-switch'].includes(direction) ? 'gpt-6-astra' : 'claude-opus-5'
    await page.locator('select.model-select').selectOption(source)
    const before = await page.getByText('CONTINUATION_COMPLETE', { exact: true }).count()
    await page.locator('textarea').first().fill(`USER_PARITY_SENTINEL ${direction}: escreva result.txt com TOOL_RESULT_SENTINEL e depois leia o arquivo.`)
    await page.locator('textarea').first().press('Enter')
    // Any permission modal refers exclusively to our synthetic Write tool.
    const approve = page.getByRole('button', { name: /Permitir uma vez|Permitir agora|Permitir$/i })
    if (direction !== 'stop-switch') await approve.first().waitFor({ state: 'visible', timeout: 2500 }).then(() => approve.first().click()).catch(() => {})
    if (direction === 'stop-switch') {
      const deadline = Date.now() + 20000
      while (!(await app.evaluate(() => process.env.TEST_AUTH_STARTED === '1'))) {
        if (await approve.first().isVisible()) await approve.first().click()
        if (Date.now() >= deadline) throw new Error(`handoff did not reach authentication: ${JSON.stringify(counts)} ${await page.locator('body').innerText()}`)
        await new Promise((r) => setTimeout(r, 30))
      }
      await page.getByTitle('Parar tarefa atual', { exact: true }).click()
      await new Promise((r) => setTimeout(r, 1700))
      assert.equal(counts.claude, 0, 'Stop still dispatched to Claude')
    } else if (direction === 'missing-auth') {
      await page.getByText(/ChatGPT não está conectado/).first().waitFor({ timeout: 45000 })
      assert.equal(counts.gpt, 0, 'disconnected provider received a request')
    } else if (direction === 'both') {
      await page.getByText(/Claude e GPT atingiram o limite/).first().waitFor({ timeout: 45000 })
      assert.ok(counts.claude <= 2 && counts.gpt <= 2, 'unbounded provider loop')
    } else {
      await page.waitForFunction((before) => [...document.querySelectorAll('.msg')].filter((n) => n.textContent?.includes('CONTINUATION_COMPLETE')).length > before, before, { timeout: 45000 })
      assert.equal(await readFile(toolPath, 'utf8'), 'TOOL_RESULT_SENTINEL')
      const dest = direction === 'claude-to-gpt' ? 'gpt-6-astra' : 'claude-opus-5'
      assert.equal(await page.locator('select.model-select').inputValue(), dest)
    }
    await page.getByTitle('Parar tarefa atual', { exact: true }).waitFor({ state: 'hidden', timeout: 20000 })
    console.log('validated', direction, JSON.stringify(counts))
    await page.screenshot({ path: join(sandbox, `${direction}.png`) })
    // Exercise unmount/remount and reload with the persisted notice/model.
    await page.reload()
    await page.waitForSelector('select.model-select')
    assert.ok(await page.getByText(/Troquei automaticamente para/).count())
  }
  const firstClaude = requests.find((r) => r.mode === 'claude-to-gpt' && r.provider === 'claude').body
  const firstGpt = requests.find((r) => r.mode === 'claude-to-gpt' && r.provider === 'gpt').body
  const originalUser = firstClaude.messages.flatMap((m) => typeof m.content === 'string' ? [m.content] : m.content.filter((b) => b.type === 'text').map((b) => b.text)).find((s) => s.includes('USER_PARITY_SENTINEL'))
  assert.ok(firstGpt.input.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'input_text' && b.text === originalUser)), 'original user context changed across providers')
  for (const marker of ['USER_PARITY_SENTINEL', 'DOC_PARITY_SENTINEL', 'MEMORY_PARITY_SENTINEL', 'SKILL_PARITY_SENTINEL', 'TOOL_RESULT_SENTINEL']) {
    assert.ok(JSON.stringify(firstClaude).includes(marker) || marker === 'TOOL_RESULT_SENTINEL', `Claude missing ${marker}`)
    assert.ok(JSON.stringify(firstGpt).includes(marker), `GPT missing ${marker}`)
  }
  console.log(JSON.stringify({ ok: true, sandbox, requests: requests.length, parity: 'user/docs/memory/skills/tool history preserved' }))
} finally {
  if (app) {
    let timer
    const child = app.process()
    try { await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error('Electron close timed out')) }, 15000) })]) }
    finally { clearTimeout(timer) }
  }
  server.closeAllConnections(); server.close()
}
