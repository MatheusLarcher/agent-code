// Real user-configured Electron/SDK/provider; default has no network/auth mocks.
// --failover injects only one quota; --cleanup also exercises rename/delete.
// Creates a clearly labelled diagnostic conversation in a temporary project.
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const model = process.argv[2] || 'gpt-6-astra'
// Optional controlled quota at the transport boundary; both LLMs/auth stay real.
const injectQuota = process.argv.includes('--failover')
const project = await mkdtemp(join(tmpdir(), 'agent-gpt-live-'))
await mkdir(join(project, 'docs'))
await writeFile(join(project, 'docs', 'probe.md'), '# Validação\nDOC_LIVE_SENTINEL\n')
await writeFile(join(project, 'probe.txt'), 'FILE_LIVE_SENTINEL\n')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
let app, timer
try {
  app = await electron.launch({ args: ['.'], env, timeout: 30000 })
  const child = app.process()
  timer = setTimeout(() => { child.kill(); process.exitCode = 1 }, 300000)
  const page = await app.firstWindow({ timeout: 20000 })
  page.on('dialog', (d) => void d.accept().catch(() => {}))
  await page.waitForFunction(() => Boolean(window.api))
  // Observe the actual backend response without changing it or recording tokens.
  await app.evaluate((_electron, injectQuota) => {
    globalThis.__gptProbe = { errors: [], requests: [], injectedQuota: false }
    const original = globalThis.fetch
    globalThis.fetch = async (...args) => {
      if (injectQuota && !globalThis.__gptProbe.injectedQuota && String(args[0]).includes('/backend-api/codex/responses')) {
        const body = JSON.parse(args[1]?.body || '{}')
        if (body.input?.some((item) => item.type === 'function_call_output')) {
          globalThis.__gptProbe.injectedQuota = true
          return new Response(JSON.stringify({ error:{ code:'usage_limit_reached', message:'You have hit your ChatGPT usage limit.' } }), { status:429, headers:{'Content-Type':'application/json'} })
        }
      }
      const response = await original(...args)
      if (String(args[0]).includes('/backend-api/codex/responses')) {
        const body = JSON.parse(args[1]?.body || '{}')
        globalThis.__gptProbe.requests.push({ model: body.model, bytes: String(args[1]?.body).length, inputItems: body.input?.length, status: response.status })
        if (!response.ok) globalThis.__gptProbe.errors.push({ status: response.status, detail: (await response.clone().text()).slice(0, 2500) })
      }
      return response
    }
  }, injectQuota)
  const id = `gpt-live-${randomUUID()}`, now = Date.now(), title = `Validação ${model} ${randomUUID().slice(0, 6)}`
  await page.evaluate(async ({ id, model, project, now, title }) => {
    await window.api.upsertConversation({ id, payload: { id, title, cwd: project, model, effort: 'low', sdkSessionId: null, messages: [], tokens: { context: 0, output: 0, cost: 0 }, createdAt: now, updatedAt: now } })
  }, { id, model, project, now, title })
  await page.reload()
  await page.waitForSelector('select.model-select')
  await page.locator('.conv-row').filter({ hasText: title }).first().click()
  if (!(await page.locator('.conv-row.active').first().textContent())?.includes(title)) throw new Error('Diagnostic conversation was not selected')
  if (await page.locator('select.model-select').inputValue() !== model) throw new Error('Unexpected selected model')
  await page.evaluate(() => {
    window.__liveEvents = []
    window.api.onAgentEvent((e) => window.__liveEvents.push(e))
  })
  console.log(JSON.stringify({ stage: 'opened', model, project, id }))
  const prompt = 'Teste de diagnóstico do Agent Code. Não execute tarefas anteriores nem altere outros projetos. Use Read para ler probe.txt nesta pasta e responda somente com o conteúdo do arquivo e o marcador da documentação docs/probe.md. Não use subagentes.'
  await page.locator('textarea').first().fill(prompt)
  await page.locator('textarea').first().press('Enter')
  await page.waitForFunction((id) => window.__liveEvents.some((e) => e.convId === id && ['result', 'error'].includes(e.event.kind)), id, { timeout: 140000 })
  const report = await page.evaluate((id) => window.__liveEvents.filter((e) => e.convId === id).map(({ event:e }) => ({ kind: e.kind, name: e.name, text: e.kind === 'assistant-text' || e.kind === 'error' || e.kind === 'result' ? e.text : undefined, isError: e.isError, model: e.model })), id)
  console.log(JSON.stringify({ stage: 'finished', report, transport: await app.evaluate(() => globalThis.__gptProbe) }, null, 2))
  await page.screenshot({ path: join(project, 'live.png') })
  const success = report.some((e) => e.kind === 'tool-use' && e.name === 'Read') && report.some((e) => e.kind === 'assistant-text' && e.text?.includes('FILE_LIVE_SENTINEL')) && !report.some((e) => e.kind === 'error' || (e.kind === 'result' && e.isError))
  if (!success) throw new Error('Real provider/tool round failed')
  if (injectQuota && !report.some((e) => e.kind === 'provider-switch')) throw new Error('Expected automatic provider switch')
  // Unmount/remount the chat, then reload from the actual configured database.
  await page.locator('.conv-row').filter({ hasNotText: title }).first().click()
  await page.locator('.conv-row').filter({ hasText: title }).first().click()
  await page.reload()
  await page.waitForFunction(() => document.body.textContent.includes('FILE_LIVE_SENTINEL'))
  if (!(await page.locator('.conv-row.active').first().textContent())?.includes(title)) throw new Error('Reload selected another conversation')
  await page.evaluate(() => {
    window.__liveEvents = []
    window.api.onAgentEvent((e) => window.__liveEvents.push(e))
  })
  await page.locator('textarea').first().fill('Continue o diagnóstico: use Read em missing-probe.txt (arquivo intencionalmente inexistente). Após o erro esperado, use Read em probe.txt e responda com RELOAD_RECOVERED e seu conteúdo. Não altere arquivos nem use subagentes.')
  await page.locator('textarea').first().press('Enter')
  await page.waitForFunction((id) => window.__liveEvents.some((e) => e.convId === id && ['result', 'error'].includes(e.event.kind)), id, { timeout: 140000 })
  const resumed = await page.evaluate((id) => window.__liveEvents.filter((e) => e.convId === id).map(({ event:e }) => ({ kind:e.kind, name:e.name, isError:e.isError, text:['result','error'].includes(e.kind) ? e.text : undefined })), id)
  console.log(JSON.stringify({ stage:'resumed-after-reload', resumed, transport:await app.evaluate(() => globalThis.__gptProbe) }, null, 2))
  await page.screenshot({ path:join(project, 'reload-recovered.png') })
  if (!resumed.some((e) => e.kind === 'tool-result' && e.isError) || !resumed.some((e) => e.kind === 'result' && !e.isError && e.text?.includes('RELOAD_RECOVERED') && e.text.includes('FILE_LIVE_SENTINEL'))) throw new Error('Reload/tool-error recovery failed')
  if (process.argv.includes('--cleanup')) {
    const renamed = `${title} verificado`
    await page.locator('.conv-row').filter({ hasText:title }).first().dblclick()
    await page.locator('.conv-rename').fill(renamed)
    await page.locator('.conv-rename').press('Enter')
    await page.waitForFunction(async ({id,renamed}) => (await window.api.loadAllConversations()).some((c) => c.id === id && c.title === renamed), {id,renamed})
    await page.reload()
    const row = page.locator('.conv-row').filter({ hasText:renamed }).first()
    await row.locator('.conv-del').click()
    await page.getByRole('dialog').getByRole('button', {name:'Excluir', exact:true}).click()
    await page.waitForFunction(async (id) => !(await window.api.loadAllConversations()).some((c) => c.id === id), id)
    console.log(JSON.stringify({stage:'renamed-reloaded-deleted', id}))
  }
} catch (error) {
  console.error(String(error))
  if (app) console.log(JSON.stringify(await app.evaluate(() => globalThis.__gptProbe).catch(() => null)))
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  if (app) {
    const child = app.process()
    let closeTimer
    try { await Promise.race([app.close(), new Promise((_, reject) => { closeTimer = setTimeout(() => { child.kill(); reject(new Error('close timeout')) }, 20000) })]) }
    finally { clearTimeout(closeTimer) }
  }
}
