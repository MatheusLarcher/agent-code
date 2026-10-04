// Real Electron, renderer, IPC and login driver. Only the remote OAuth/CLI
// boundary is simulated; all credentials and databases live in a temp folder.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, chromium } from 'playwright'

const root = process.cwd()
const sandbox = await mkdtemp(join(tmpdir(), 'agent-login-smoke-'))
const home = join(sandbox, 'home')
const machine = join(home, '.claude')
const userData = join(sandbox, 'user-data')
await mkdir(join(home, '.agent-code'), { recursive: true })
await mkdir(machine)
await writeFile(join(home, '.agent-code', 'location.json'), JSON.stringify({ cacheDir: join(sandbox, 'cache') }))
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const dir = url.searchParams.get('dir')
  if (!dir || !resolve(dir).startsWith(resolve(sandbox))) { res.writeHead(400).end(); return }
  if (url.pathname === '/complete') {
    await writeFile(join(dir, 'oauth-reply'), url.searchParams.get('result'))
    res.end('Autorizacao encerrada. Volte ao app.')
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    const query = `dir=${encodeURIComponent(dir)}`
    res.end(`<h1>OAuth de teste</h1><a href="/complete?${query}&result=ok">Autorizar</a> <a href="/complete?${query}&result=fail">Cancelar</a>`)
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const fakeCli = join(sandbox, 'oauth-cli.cjs')
await writeFile(fakeCli, `
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.CLAUDE_CONFIG_DIR;
const credential = path.join(dir, '.credentials.json');
if (process.argv[3] === 'status') {
  const present = fs.existsSync(credential);
  console.log(JSON.stringify({loggedIn:present,authMethod:present?'claude.ai':'none',email:dir === ${JSON.stringify(machine)} ? 'machine@example.test' : 'extra@example.test',subscriptionType:'max'}));
} else {
  const reply = path.join(dir, 'oauth-reply');
  fs.rmSync(reply, {force:true});
  console.log('Opening browser: http://127.0.0.1:${port}/oauth?dir=' + encodeURIComponent(dir));
  const timer = setInterval(() => {
    if (!fs.existsSync(reply)) return;
    clearInterval(timer);
    const ok = fs.readFileSync(reply,'utf8') === 'ok';
    fs.rmSync(reply, {force:true});
    if (!ok) process.exit(1);
    fs.writeFileSync(credential,JSON.stringify({claudeAiOauth:{accessToken:'TEST-ONLY',expiresAt:Date.now()+3600000,subscriptionType:'max'}}));
    fs.writeFileSync(path.join(dir,'.claude.json'),JSON.stringify({oauthAccount:{emailAddress:dir === ${JSON.stringify(machine)} ? 'machine@example.test' : 'extra@example.test'}}));
    console.log('Login successful');
    process.exit(0);
  }, 100);
}
`)
const entry = resolve('out/main/login-smoke.mjs')
await build({
  entryPoints: ['src/main/index.ts'], outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external',
  plugins: [{ name: 'oauth-boundary', setup(b) {
    b.onLoad({ filter: /[\\/]main[\\/](claudeCli|auth|login|index)\.ts$/ }, async ({ path }) => {
      if (path.endsWith('claudeCli.ts')) return { contents: `export function claudeCliPath(){return ${JSON.stringify(process.execPath)}}`, loader: 'ts' }
      let contents = await readFile(path, 'utf8')
      if (path.endsWith('index.ts')) contents = contents.replaceAll('void shell.openExternal(url)', ';(process.__loginUrls ??= []).push(url)')
      contents = contents.replace("['auth', 'status', '--json']", `[${JSON.stringify(fakeCli)}, 'auth', 'status', '--json']`)
      contents = contents.replace("['auth', 'login', '--claudeai']", `[${JSON.stringify(fakeCli)}, 'auth', 'login', '--claudeai']`)
      return { contents, loader: 'ts' }
    })
  } }]
})
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(sandbox, 'appdata'), LOCALAPPDATA: join(sandbox, 'localappdata'), CLAUDE_CONFIG_DIR: machine }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
delete env.PLAYWRIGHT_BROWSERS_PATH
let app, browser
const phases = []
const note = (phase) => { phases.push(phase); console.log('PASS', phase) }
try {
  app = await electron.launch({ args: [entry, `--user-data-dir=${userData}`], cwd: root, env, timeout: 30000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('dialog', (d) => void d.accept().catch(() => undefined))
  await page.waitForFunction(() => !!window.api)
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), userData)
  await app.evaluate(() => { process.__loginUrls = [] })
  browser = await chromium.launch({ headless: true })
  const oauth = await browser.newPage()
  const settings = async () => {
    await page.getByTitle('Configurações (voz, Ollama, pasta de dados, etc.)', { exact: true }).click()
    await page.getByRole('tab', { name: /Modelos e contas/ }).click()
    await page.locator('.claude-account-row').first().waitFor()
  }
  const closeSettings = () => page.locator('.settings-modal').getByRole('button', { name: 'Cancelar', exact: true }).click()
  const countUrls = () => app.evaluate(() => process.__loginUrls.length)
  const finishOAuth = async (before, outcome = 'Autorizar') => {
    await page.waitForFunction(() => document.querySelector('.claude-accounts') != null)
    let url
    const deadline = Date.now() + 15000
    while (!url) {
      url = await app.evaluate((_, n) => process.__loginUrls[n], before)
      if (Date.now() > deadline) throw new Error('OAuth URL was not opened')
      if (!url) await new Promise((r) => setTimeout(r, 100))
    }
    await oauth.goto(url)
    await oauth.getByRole('link', { name: outcome, exact: true }).click()
  }
  await settings()
  await page.getByRole('button', { name: 'Entrar de novo', exact: true }).waitFor()
  assert.equal(await page.locator('.claude-account-row').count(), 1)
  note('estado vazio: conta padrão sem login oferece renovação')

  let before = await countUrls()
  await page.getByRole('button', { name: 'Entrar de novo', exact: true }).click()
  await finishOAuth(before)
  await page.locator('.claude-account-row').filter({ hasText: 'conectada' }).waitFor()
  note('conta padrão: clique → OAuth → login conectado')
  await closeSettings()
  await settings()
  await page.locator('.claude-account-row').filter({ hasText: 'conectada' }).waitFor()
  await closeSettings()
  await page.reload()
  await settings()
  await page.locator('.claude-account-row').filter({ hasText: 'conectada' }).waitFor()
  note('conta padrão preservada ao desmontar, remontar e F5')

  before = await countUrls()
  await page.getByRole('button', { name: 'Adicionar conta', exact: true }).click()
  await finishOAuth(before)
  await page.locator('.claude-account-row').nth(1).waitFor()
  const extra = (await page.evaluate(() => window.api.claudeAccountsList())).find((a) => !a.isDefault)
  assert.ok(extra)
  const extraDir = join(userData, 'agent-code-local', 'claude-accounts', extra.id)
  const expireExtra = async () => {
    await writeFile(join(extraDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'TEST-ONLY', expiresAt: 1 } }))
    await closeSettings()
    await settings()
    await page.locator('.claude-account-row').filter({ hasText: 'login expirado' }).waitFor()
  }
  await expireExtra()
  before = await countUrls()
  await page.getByRole('button', { name: 'Entrar de novo', exact: true }).click()
  await new Promise((r) => setTimeout(r, 3000))
  assert.equal(await page.getByRole('button', { name: 'Aguardando…', exact: true }).count(), 1)
  await finishOAuth(before)
  await page.locator('.claude-account-row').nth(1).filter({ hasText: 'conectada' }).waitFor()
  note('credencial antiga loggedIn:true não bloqueia nem encerra OAuth antes da autorização')

  await expireExtra()
  before = await countUrls()
  await page.getByRole('button', { name: 'Entrar de novo', exact: true }).click()
  await finishOAuth(before, 'Cancelar')
  await page.getByText('O login não foi concluído.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Entrar de novo', exact: true }).waitFor()
  assert.equal((await page.evaluate(() => window.api.claudeAccountsList())).find((a) => a.id === extra.id).status, 'expired')
  note('cancelamento mantém conta expirada, informa erro e libera nova tentativa')

  await closeSettings()
  await page.getByRole('button', { name: 'Detalhar consumo', exact: true }).click()
  before = await countUrls()
  await page.getByRole('button', { name: 'Entrar de novo', exact: true }).click()
  let url
  const deadline = Date.now() + 15000
  while (!url && Date.now() < deadline) {
    url = await app.evaluate((_, n) => process.__loginUrls[n], before)
    if (!url) await new Promise((r) => setTimeout(r, 100))
  }
  assert.ok(url)
  await oauth.goto(url)
  await oauth.getByRole('link', { name: 'Autorizar', exact: true }).click()
  await page.getByText('Login renovado.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Detalhar consumo', exact: true }).click()
  await page.reload()
  await settings()
  const extraRow = page.locator('.claude-account-row').nth(1)
  await extraRow.filter({ hasText: 'conectada' }).waitFor()
  note('painel de consumo: Entrar de novo abre OAuth e mantém login após F5')

  await extraRow.getByRole('button', { name: 'Renomear', exact: true }).click()
  const label = extraRow.locator('input')
  await label.fill('Conta renovada')
  await label.press('Enter')
  await extraRow.getByText('2. Conta renovada', { exact: true }).waitFor()
  await extraRow.getByRole('button', { name: 'Remover', exact: true }).click()
  await page.getByRole('dialog').filter({ hasText: 'Remover conta Claude' }).getByRole('button', { name: 'Remover', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.claude-account-row').length === 1)
  await closeSettings()
  await page.reload()
  await settings()
  assert.equal(await page.locator('.claude-account-row').count(), 1)
  note('ações encadeadas: adicionar → listar → renovar → renomear → remover → F5')
  await page.screenshot({ path: join(sandbox, 'validated.png') })
  await writeFile(join(sandbox, 'report.json'), JSON.stringify({ sandbox, phases }, null, 2))
  console.log('REPORT', join(sandbox, 'report.json'))
} catch (error) {
  if (app) {
    const page = await app.firstWindow().catch(() => null)
    if (page) { console.log((await page.locator('body').innerText()).slice(-6000)); await page.screenshot({ path: join(sandbox, 'failure.png') }) }
  }
  throw error
} finally {
  await browser?.close()
  await app?.close()
  server.close()
  await rm(entry, { force: true })
}
