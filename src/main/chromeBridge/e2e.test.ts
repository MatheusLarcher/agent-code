// @vitest-environment node
// Ponta a ponta: extensão real (instalada via install.ts) no Chromium do
// Playwright, falando com a ChromeBridge real. Pulado se o Chromium faltar.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { ChromeBridge } from './server'
import { installExtensionFiles, readManifestVersion } from './install'
import { CHROME_EXTENSION_ID } from './extensionId'
import { pickElementInChrome } from './pickElement'

const SOURCE = resolve(__dirname, '../../chromeExtension')
const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
})()

const PAGE = `<!doctype html><html><head><title>E2E</title></head><body>
<label for="name">Nome</label><input id="name">
<button id="btn" onclick="document.getElementById('out').textContent = 'ok:' + document.getElementById('name').value">Enviar</button>
<select id="sel"><option value="a">Alfa</option><option value="b">Beta</option></select>
<p id="out">vazio</p><p>Texto fixo da página</p>
<script>document.addEventListener('keydown', (e) => { document.body.dataset.key = e.key })</script>
</body></html>`

// Casos que o evento do mouse não alcança: botão disabled, botão com
// pointer-events:none (o clique cai no pai) e elemento dentro de iframe.
const HARD = `<!doctype html><html><head><title>Difícil</title></head><body style="margin:0">
<div id="wrap" style="padding:20px"><button id="dis" disabled style="width:160px;height:40px">Assinar</button></div>
<div id="pewrap" style="padding:20px"><button id="pe" style="pointer-events:none;width:160px;height:40px">Sem ponteiro</button></div>
<iframe id="fr" style="width:300px;height:120px;border:0" srcdoc="<body style='margin:0'><button id='inner' style='width:160px;height:40px'>Dentro</button></body>"></iframe>
</body></html>`

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createNetServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => res(port))
    })
  })
}

interface TabInfo { tabId: number; url: string; title: string }

describe.skipIf(!hasChromium)('ponte Chrome ponta a ponta', () => {
  let dir: string
  let http: Server
  let base: string
  let bridge: ChromeBridge
  let ctx: BrowserContext
  let tabId: number
  let page: Page

  const call = <T = Record<string, unknown>>(method: string, params: object = {}): Promise<T> =>
    bridge.call(method, params) as Promise<T>
  const evaluate = async (expression: string): Promise<unknown> =>
    JSON.parse((await call<{ value: string }>('evaluate', { tabId, expression })).value)
  const refOf = (snap: string, label: string): string => {
    const m = snap.split('\n').find((l) => l.includes(label))?.match(/^\[(e\d+)\]/)
    if (!m) throw new Error(`ref de "${label}" ausente no snapshot:\n${snap}`)
    return m[1]
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-chrome-e2e-'))
    http = createHttpServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(req.url === '/two' ? '<title>Dois</title><p>Página dois</p>' : req.url === '/hard' ? HARD : PAGE)
    })
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(http.address() as { port: number }).port}`

    const port = await freePort()
    const token = randomBytes(16).toString('hex')
    const extDir = installExtensionFiles({ sourceDir: SOURCE, targetDir: join(dir, 'ext'), ports: [port], token })
    bridge = new ChromeBridge({
      extensionId: CHROME_EXTENSION_ID, token, version: readManifestVersion(SOURCE), ports: [port]
    })
    await bridge.start()
    const connected = new Promise<void>((r) => {
      bridge.on('status', (s: { connected: boolean }) => { if (s.connected) r() })
    })

    ctx = await chromium.launchPersistentContext(join(dir, 'profile'), {
      headless: false,
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--headless=new']
    })
    await connected
    page = ctx.pages()[0] ?? (await ctx.newPage())
    await page.goto(base + '/')
    await page.bringToFront()
  }, 60_000)

  afterAll(async () => {
    await ctx?.close()
    await bridge?.stop()
    await new Promise<void>((r) => (http ? http.close(() => r()) : r()))
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('lista a aba da página de teste', async () => {
    const { tabs } = await call<{ tabs: TabInfo[] }>('listTabs')
    const tab = tabs.find((t) => t.url === base + '/')
    expect(tab).toBeDefined()
    tabId = tab!.tabId
  })

  it('snapshot, type, click, selectOption, pressKey', async () => {
    const snap = await call<{ text: string }>('snapshot', { tabId })
    expect(snap.text).toContain('Texto fixo da página')
    const input = refOf(snap.text, 'textbox "Nome"')
    const button = refOf(snap.text, 'button "Enviar"')
    const select = refOf(snap.text, 'combobox')

    await call('type', { tabId, ref: input, text: 'Maria' })
    expect(await evaluate(`document.getElementById('name').value`)).toBe('Maria')

    await call('click', { tabId, ref: button })
    expect(await evaluate(`document.getElementById('out').textContent`)).toBe('ok:Maria')

    await call('selectOption', { tabId, ref: select, value: 'Beta' })
    expect(await evaluate(`document.getElementById('sel').value`)).toBe('b')

    await call('pressKey', { tabId, key: 'Escape' })
    expect(await evaluate(`document.body.dataset.key`)).toBe('Escape')
  })

  it('sem tabId usa a aba ativa', async () => {
    const res = await call<{ value: string; tabId: number }>('evaluate', { expression: 'document.title' })
    expect(res.tabId).toBe(tabId)
    expect(JSON.parse(res.value)).toBe('E2E')
  })

  it('screenshot devolve base64 não vazio', async () => {
    const { data } = await call<{ data: string }>('screenshot', { tabId })
    expect(data.length).toBeGreaterThan(100)
    expect(Buffer.from(data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8')
  })

  it('ref velha falha após navegar', async () => {
    const snap = await call<{ text: string }>('snapshot', { tabId })
    const button = refOf(snap.text, 'button "Enviar"')
    const nav = await call<TabInfo>('navigate', { tabId, url: base + '/two' })
    expect(nav.url).toBe(base + '/two')
    expect(nav.title).toBe('Dois')
    await expect(call('click', { tabId, ref: button })).rejects.toThrow(/Ref expirada/)
  })

  // ---- "Selecionar" do composer (pickElement) ----
  const hint = (): Promise<boolean> => page.evaluate(() => !!document.getElementById('__agent_pick_hint__'))
  const picking = async (): Promise<void> => {
    await expect.poll(hint, { timeout: 10_000 }).toBe(true)
  }

  it('Selecionar: um clique na aba em foco devolve o elemento (seletor, texto, URL) e não aciona a página', async () => {
    await page.goto(base + '/')
    await page.bringToFront()
    const pending = pickElementInChrome(bridge)
    await picking()
    const box = (await page.locator('#btn').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    // O realce laranja acompanha o mouse.
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('__agent_highlight__')!).borderColor)).toBe('rgb(217, 119, 87)')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const { result, element } = await pending
    expect(result).toEqual({ status: 'picked' })
    expect(element).toMatchObject({ selector: '#btn', tagName: 'button', id: 'btn', text: 'Enviar', url: base + '/', tabName: 'chrome - E2E' })
    expect(element!.tabId).toMatch(/^chrome:[0-9]+$/)
    expect(element!.html).toContain('<button id="btn"')
    // O clique escolhido não chegou ao botão, e a página ficou limpa.
    expect(await page.evaluate(() => document.getElementById('out')!.textContent)).toBe('vazio')
    expect(await hint()).toBe(false)
    expect(await page.evaluate(() => !!document.getElementById('__agent_highlight__'))).toBe(false)
    // Um clique = um elemento: depois dele a página volta a funcionar.
    await page.click('#btn')
    expect(await page.evaluate(() => document.getElementById('out')!.textContent)).toBe('ok:')
  })

  it('Selecionar: alcança botão disabled, pointer-events:none e elemento dentro de iframe', async () => {
    await page.goto(base + '/hard')
    await page.bringToFront()
    const pickAt = async (box: { x: number; y: number; width: number; height: number }) => {
      const pending = pickElementInChrome(bridge)
      await picking()
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await page.mouse.move(x - 30, y - 30)
      await page.mouse.move(x, y, { steps: 5 })
      await page.waitForTimeout(100)
      await page.mouse.click(x, y)
      return pending
    }
    const dis = await pickAt((await page.locator('#dis').boundingBox())!)
    expect(dis.element).toMatchObject({ selector: '#dis', tagName: 'button', text: 'Assinar' })
    const pe = await pickAt((await page.locator('#pe').boundingBox())!)
    expect(pe.element).toMatchObject({ selector: '#pe', tagName: 'button' })
    const frameBox = (await page.locator('#fr').boundingBox())!
    const inner = await pickAt({ x: frameBox.x, y: frameBox.y, width: 160, height: 40 })
    expect(inner.element).toMatchObject({ selector: '#fr >>> #inner', tagName: 'button', text: 'Dentro' })
    expect(await page.evaluate(() => !!document.getElementById('__agent_pick_shield__'))).toBe(false)
  })

  it('Selecionar: Esc cancela sem erro e limpa a página', async () => {
    const pending = pickElementInChrome(bridge)
    await picking()
    await page.keyboard.press('Escape')
    expect(await pending).toEqual({ result: { status: 'canceled' }, element: null })
    expect(await hint()).toBe(false)
  })

  it('Selecionar: a página navegar no meio encerra com aviso (não fica pendurado)', async () => {
    const pending = pickElementInChrome(bridge)
    await picking()
    await page.goto(base + '/two')
    const { result, element } = await pending
    expect(element).toBeNull()
    expect(result).toEqual({ status: 'navigated', message: 'A página mudou durante a seleção. Clique em Selecionar de novo.' })
  })
}, 90_000)
