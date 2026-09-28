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
import { chromium, type BrowserContext } from 'playwright'
import { ChromeBridge } from './server'
import { installExtensionFiles, readManifestVersion } from './install'
import { CHROME_EXTENSION_ID } from './extensionId'

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
      res.end(req.url === '/two' ? '<title>Dois</title><p>Página dois</p>' : PAGE)
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
    const page = ctx.pages()[0] ?? (await ctx.newPage())
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
}, 90_000)
