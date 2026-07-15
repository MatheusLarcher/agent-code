import { app } from 'electron'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Browser, BrowserContext, Page } from 'playwright'
import type { BrowserFrame, BrowserInput, BrowserState, PickedElement, TabInfo, TabKind } from '../shared/ipc'
import { TAB_KINDS, tabName } from '../shared/ipc'
import { findDevice, DEFAULT_DEVICE_ID } from '../shared/devices'
import { PICKER_SCRIPT } from './picker'
import {
  DEFAULT_VIEWPORT,
  DEVICE_SCALE,
  JPEG_QUALITY,
  MAX_FRAME,
  EMPTY_STATE,
  isAndroid,
  nextTabId,
  type Tab
} from './browserTabs'
import {
  gotoUrl,
  pageSnapshot,
  pageScreenshot,
  clickSelector as pageClick,
  fillOrType,
  readText,
  evaluateExpression,
  setSelectMode as applyPageSelectMode,
  syncSelectMode,
  forwardPageInput
} from './pageActions'
import { bootAndroidDevice, forwardAndroidInput } from './android/androidTab'
import { hideChromeWindowFromTaskbar } from './windowsTaskbar'
import type { AndroidDevice } from './android/androidDevice'
import type { Progress } from './android/androidEnv'

interface BrowserCallbacks {
  onFrame: (frame: BrowserFrame) => void
  onState: (state: BrowserState) => void
  onPicked: (el: PickedElement) => void
  /** Progress lines while an Android device/emulator boots (for the UI overlay). */
  onAndroidProgress?: (line: string) => void
}

/**
 * Drives an embedded browser for one conversation. The page tree is a set of
 * **tabs** — `web` (a headless Chromium page streamed via CDP screencast) or
 * `android` (a live device/emulator streamed via adb). Exactly one tab is active
 * at a time and is the only one streamed to the UI and targeted by the tools.
 */
export class BrowserController {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private tabs = new Map<string, Tab>()
  private activeTabId: string | null = null
  private selectMode = false
  /** Current page viewport in CSS px — follows the panel size in the UI. */
  private viewport = { ...DEFAULT_VIEWPORT }
  /** Safety timers that force the loading spinner off if 'load' never fires. */
  private loadTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** `profileKey` (the conversation id) gives each browser its own persistent
   *  profile dir, so logins/cookies survive restarts and two conversations don't
   *  fight over the same profile lock. */
  constructor(
    private readonly cb: BrowserCallbacks,
    private readonly profileKey: string = 'default'
  ) {}

  get isLaunched(): boolean {
    return this.activeTab() !== null
  }

  // ---- tab bookkeeping ----

  private activeTab(): Tab | null {
    return this.activeTabId ? this.tabs.get(this.activeTabId) ?? null : null
  }

  /** Snapshot of all tabs (in insertion order) for the UI and the agent. */
  tabsInfo(): TabInfo[] {
    return [...this.tabs.values()].map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      url: t.url,
      active: t.id === this.activeTabId
    }))
  }

  /** Human/agent-readable listing of the open tabs (used by browser_list_tabs). */
  listTabsText(): string {
    if (this.tabs.size === 0) return 'Nenhuma aba aberta.'
    const lines = [...this.tabs.values()].map(
      (t) => `${t.id === this.activeTabId ? '▶' : ' '} [${t.id}] ${tabName(t)} — ${t.url || 'about:blank'}`
    )
    const active = this.activeTab()
    return `Abas abertas (${this.tabs.size}):\n${lines.join('\n')}\n\nAba ativa: ${active ? `"${tabName(active)}" (${active.id})` : 'nenhuma'}.`
  }

  // ---- launch / context ----

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context
    const { chromium } = await import('playwright')
    const safeKey = this.profileKey.replace(/[^a-z0-9_-]/gi, '_') || 'default'
    // Tests run outside the Electron runtime (no app.getPath) and headless.
    const isTest = !!process.env.VITEST
    let root: string
    try {
      root = app.getPath('userData')
    } catch {
      root = join(tmpdir(), 'agent-code')
    }
    const userDataDir = join(root, 'browser-profiles', safeKey)
    // A REAL, headed Chrome — parked far offscreen so its window never shows, but
    // streamed into the in-app canvas via CDP screencast. Headed + real Chrome (vs
    // headless Chromium) renders crisp (captured at 2× DPR) and looks like a normal
    // browser to sites: real UA, a persistent profile (logins survive), and none of
    // the automation flags that get bots blocked.
    const opts = {
      headless: isTest,
      viewport: this.viewport,
      deviceScaleFactor: DEVICE_SCALE,
      locale: 'pt-BR',
      // Drop the "controlled by automation" flag that also exposes navigator.webdriver.
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-default-browser-check',
        '--no-first-run',
        '--disable-blink-features=AutomationControlled',
        '--window-position=-32000,-32000',
        `--window-size=${this.viewport.width},${this.viewport.height}`,
        // Keep the offscreen window painting at full speed (no background throttling).
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ]
    }
    // Prefer the user's installed Chrome (most "normal"); fall back to the bundled
    // Chromium if Chrome isn't present (and always in tests, for speed/determinism).
    try {
      if (isTest) throw new Error('use bundled chromium in tests')
      this.context = await chromium.launchPersistentContext(userDataDir, { ...opts, channel: 'chrome' })
    } catch {
      this.context = await chromium.launchPersistentContext(userDataDir, opts)
    }
    this.browser = this.context.browser()
    // Best-effort: hide the real Chrome window from the Windows taskbar (it's
    // parked off-screen, but Windows still lists any top-level window in the
    // taskbar regardless of position). AWAITED here, before any tab/screencast
    // exists yet — the fix briefly hides+reshows the native window (see
    // windowsTaskbar.ts for why), which is only safe to do before we're capturing
    // it. Skipped under tests — the headless test browser has no window to find,
    // and the retry loop would just waste several seconds per test run.
    if (!isTest) await hideChromeWindowFromTaskbar(userDataDir)
    // Hide the last obvious automation signal some sites sniff.
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })
    // Expose at the CONTEXT level so every tab (current and future) shares the
    // picker binding; `source.page` tells us which tab a pick came from.
    await this.context.exposeBinding(
      '__agentPick',
      (source, data: Omit<PickedElement, 'tabId' | 'tabName'>) => this.onPick(source.page, data)
    )
    await this.context.addInitScript(PICKER_SCRIPT)
    return this.context
  }

  /** Ensure the browser is up with at least one web tab; returns its page. */
  async ensureLaunched(): Promise<Page> {
    return this.ensureWebPage()
  }

  /** A safe web page for browser tools, regardless of the active preview kind. */
  private async activePage(): Promise<Page> {
    return this.ensureWebPage()
  }

  /**
   * Ensure the active tab is a real WEB tab and return its page. Used before
   * loading a URL so navigations never hijack a Stitch design tab (a web-backed
   * preview meant only to show the generated mockup) or an Android tab — instead
   * we reuse an existing web tab or open a fresh one.
   */
  private async ensureWebPage(): Promise<Page> {
    await this.ensureContext()
    const t = this.activeTab()
    if (t && t.kind === 'web' && t.page) return t.page
    // Reuse the most-recent web tab if any; otherwise open a new one.
    const web = [...this.tabs.values()].reverse().find((x) => x.kind === 'web' && x.page)
    if (web) {
      await this.selectTab(web.id)
      return web.page!
    }
    return (await this.openWebTab()).page!
  }

  /** The active tab's AndroidDevice, or null when the active tab isn't Android. */
  activeAndroidDevice(): AndroidDevice | null {
    const t = this.activeTab()
    return t && isAndroid(t) ? t.device : null
  }

  /** Open (or focus) an Android preview tab and return its device. Used by android tools. */
  async openAndroidPreview(progress?: Progress): Promise<AndroidDevice> {
    const existing = [...this.tabs.values()].find((t) => isAndroid(t) && t.device)
    if (existing?.device) {
      await this.selectTab(existing.id)
      return existing.device
    }
    return this.openAndroidTab(progress)
  }

  // ---- tab lifecycle (also the agent's tab tools) ----

  /**
   * Open a new tab and make it active. `web` and `android` are implemented;
   * `iphone` is reserved (its name/icon exist for the UI) and returns a message.
   */
  async newTab(kind: TabKind = 'web', url?: string): Promise<string> {
    if (!TAB_KINDS[kind]?.implemented) {
      return `O tipo de aba "${kind}" ainda não está implementado.`
    }
    if (kind === 'stitch') {
      return 'Abas Stitch são abertas automaticamente ao gerar um design — não há como abri-las manualmente.'
    }
    if (kind === 'android') {
      try {
        const device = await this.openAndroidTab()
        const active = this.activeTab()!
        return `Aba Android aberta e ativada: "${tabName(active)}" (id ${active.id}, ${device.model}). A tela do dispositivo está sendo transmitida no preview.`
      } catch (e) {
        return `Não foi possível abrir o Android: ${e instanceof Error ? e.message : String(e)}`
      }
    }
    if (kind === 'file') {
      const tab: Tab = {
        id: nextTabId(),
        kind: 'file',
        page: null,
        cdp: null,
        device: null,
        title: url ? url.split(/[\\/]/).pop() || 'Arquivo' : 'Arquivo',
        url: url || '',
        loading: false,
        canGoBack: false,
        canGoForward: false
      }
      this.tabs.set(tab.id, tab)
      this.activeTabId = tab.id
      this.emitState()
      await this.refreshView()
      return `Aba de arquivo aberta e ativada: "${tabName(tab)}" (id ${tab.id}).`
    }
    const tab = await this.openWebTab()
    if (url) await this.navigate(url)
    else {
      this.emitState()
      await this.refreshView()
    }
    return `Nova aba aberta e ativada: "${tabName(tab)}" (id ${tab.id}). Reaproveite esta aba para as próximas ações; só abra outra se precisar de uma página separada.`
  }

  /**
   * Render a Google Stitch design in a dedicated `stitch` preview tab and
   * activate it. Backed by a Playwright page (same streaming as a web tab) but
   * marked `kind:'stitch'` so the UI shows the Aplicar/Descartar approval bar.
   * The agent calls this (via the stitchpreview MCP tool) after generating a
   * mockup; nothing is written to the project until the user approves.
   */
  async showStitchDesign(html: string, title?: string): Promise<string> {
    const context = await this.ensureContext()
    const page = await context.newPage()
    await page.bringToFront().catch(() => undefined)
    const label = (title && title.trim()) || 'Stitch design'
    const tab: Tab = { id: nextTabId(), kind: 'stitch', page, cdp: null, device: null, title: label, url: '', loading: false, canGoBack: false, canGoForward: false }
    this.tabs.set(tab.id, tab)
    this.wireTab(tab)
    this.activeTabId = tab.id
    await this.applyViewport(page)
    await page.setContent(html, { waitUntil: 'load' }).catch(() => undefined)
    tab.title = label // keep the design label even after the page 'load' fires
    await this.startScreencast(tab)
    await this.reapplySelectMode()
    this.emitState()
    await this.refreshView()
    return (
      `Design do Stitch exibido no preview na aba "${tabName(tab)}" (id ${tab.id}). ` +
      `PARE e peça ao usuário para revisar e aprovar pelo preview: há os botões "Aplicar no projeto" ` +
      `e "Descartar" na barra da aba. NÃO implemente nada no projeto até o usuário aprovar.`
    )
  }

  /** Create a web page, wire it, start streaming, and activate it. */
  private async openWebTab(): Promise<Tab> {
    const context = await this.ensureContext()
    const page = await context.newPage()
    // Real Chrome only exempts the *frontmost* tab from its own background/discard
    // heuristics (Memory Saver, tab freezing) — our launch flags only cover window-
    // level occlusion, not per-tab backgrounding within the same window. Without
    // this, a page we still consider "active" can silently get discarded/reset by
    // Chrome itself between tool calls, with no navigation or reload on our side.
    await page.bringToFront().catch(() => undefined)
    const tab: Tab = { id: nextTabId(), kind: 'web', page, cdp: null, device: null, title: '', url: page.url(), loading: false, canGoBack: false, canGoForward: false }
    this.tabs.set(tab.id, tab)
    this.wireTab(tab)
    this.activeTabId = tab.id
    await this.applyViewport(page)
    await this.startScreencast(tab)
    await this.reapplySelectMode()
    this.emitState()
    return tab
  }

  /** Boot a device/emulator, open an Android tab streaming its screen, and activate it. */
  private async openAndroidTab(progress?: Progress): Promise<AndroidDevice> {
    // Mirror progress to the caller (agent tool) AND the UI overlay.
    const report: Progress = (l) => {
      progress?.(l)
      this.cb.onAndroidProgress?.(l)
    }
    const device = await bootAndroidDevice(report) // throws if the toolchain isn't installed yet
    // Start at the default device model (Galaxy S26 Ultra) so the frame/preview
    // shows a real phone size from the first frame.
    const def = findDevice(DEFAULT_DEVICE_ID)
    if (def) await device.setScreenSize(def.width, def.height, def.dpi).catch(() => undefined)
    const tab: Tab = {
      id: nextTabId(),
      kind: 'android',
      page: null,
      cdp: null,
      device,
      title: device.model,
      url: '',
      loading: false,
      canGoBack: false,
      canGoForward: false
    }
    this.tabs.set(tab.id, tab)
    this.activeTabId = tab.id
    device.startStreaming((f) => {
      // Only the active tab paints the panel — mirror the web screencast gating.
      if (tab.id === this.activeTabId) {
        this.cb.onFrame({ data: f.data, width: f.width, height: f.height, mime: 'image/png' })
      }
    })
    this.emitState()
    await this.refreshView()
    return device
  }

  /** Apply a device model's screen size (px) to the active Android preview. */
  async setAndroidSize(width: number, height: number, dpi?: number): Promise<string> {
    const device = this.activeAndroidDevice()
    if (!device) return 'Nenhuma aba Android ativa.'
    await device.setScreenSize(width, height, dpi)
    await this.refreshView()
    return `Tela ajustada para ${width}×${height}${dpi ? ` @ ${dpi}dpi` : ''}.`
  }

  /** Rename an Android tab (e.g. to the installed app's name → "android - <app>"). */
  setAndroidTabTitle(device: AndroidDevice, title: string): void {
    for (const t of this.tabs.values()) {
      if (t.device === device) {
        t.title = title
        this.emitState()
      }
    }
  }

  /** Make a tab the active (controlled + streamed) one. */
  async selectTab(id: string): Promise<string> {
    const tab = this.tabs.get(id)
    if (!tab) return `Aba ${id} não encontrada.`
    this.activeTabId = id
    if (tab.page) await tab.page.bringToFront().catch(() => undefined)
    await this.applyViewport(tab.page)
    await this.reapplySelectMode()
    this.emitState()
    await this.refreshView()
    return `Aba ativa agora: "${tabName(tab)}" (id ${id}).`
  }

  /** Close a tab; if it was active, the most recent remaining tab takes over. */
  async closeTab(id: string): Promise<string> {
    const tab = this.tabs.get(id)
    if (!tab) return `Aba ${id} não encontrada.`
    const name = tabName(tab)
    const lt = this.loadTimers.get(id)
    if (lt) {
      clearTimeout(lt)
      this.loadTimers.delete(id)
    }
    this.tabs.delete(id)
    try {
      if (tab.device) await tab.device.stop()
      else await tab.page?.close()
    } catch {
      /* already gone */
    }
    if (this.activeTabId === id) {
      const remaining = [...this.tabs.keys()]
      this.activeTabId = remaining.length ? remaining[remaining.length - 1] : null
      const next = this.activeTab()
      if (next) {
        await this.applyViewport(next.page)
        await this.reapplySelectMode()
      }
    }
    this.emitState()
    if (this.activeTab()) await this.refreshView()
    return `Aba fechada: "${name}". ${this.tabs.size} aba(s) restante(s).`
  }

  private wireTab(tab: Tab): void {
    const page = tab.page
    if (!page) return // Android tabs have no Playwright page to wire.
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.setLoading(tab, true)
        if (tab.id === this.activeTabId) void this.reapplySelectMode()
        void this.updateTabMeta(tab)
      }
    })
    page.on('load', () => {
      this.setLoading(tab, false)
      void this.updateTabMeta(tab)
    })
  }

  /** Flip a tab's loading flag and repaint the toolbar. A safety timer clears it
   *  if the page's 'load' never fires (SPAs, stalled requests). */
  private setLoading(tab: Tab, value: boolean): void {
    const pending = this.loadTimers.get(tab.id)
    if (pending) {
      clearTimeout(pending)
      this.loadTimers.delete(tab.id)
    }
    tab.loading = value
    if (value) {
      this.loadTimers.set(
        tab.id,
        setTimeout(() => {
          tab.loading = false
          this.loadTimers.delete(tab.id)
          if (tab.id === this.activeTabId) this.emitState()
        }, 20000)
      )
    }
    if (tab.id === this.activeTabId) this.emitState()
  }

  private async updateTabMeta(tab: Tab): Promise<void> {
    if (!tab.page) return
    // Stitch tabs render injected HTML (about:blank) and carry a fixed design
    // label — don't overwrite it with the page's (empty) title/url.
    if (tab.kind === 'stitch') {
      this.emitState()
      return
    }
    tab.url = tab.page.url()
    try {
      tab.title = await tab.page.title()
    } catch {
      /* navigating */
    }
    await this.updateNavigationState(tab)
    this.emitState()
  }

  private async updateNavigationState(tab: Tab): Promise<void> {
    if (!tab.cdp || tab.kind !== 'web') {
      tab.canGoBack = false
      tab.canGoForward = false
      return
    }
    try {
      const history = await tab.cdp.send('Page.getNavigationHistory')
      tab.canGoBack = history.currentIndex > 0
      tab.canGoForward = history.currentIndex < history.entries.length - 1
    } catch {
      tab.canGoBack = false
      tab.canGoForward = false
    }
  }

  // ---- streaming / view ----

  private async startScreencast(tab: Tab): Promise<void> {
    if (!this.context || !tab.page) return
    tab.cdp = await this.context.newCDPSession(tab.page)
    await tab.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: JPEG_QUALITY,
      maxWidth: MAX_FRAME.width,
      maxHeight: MAX_FRAME.height,
      everyNthFrame: 1
    })
    tab.cdp.on('Page.screencastFrame', async (params: { data: string; sessionId: number }) => {
      // Only the active tab paints the panel — background tabs are dropped.
      if (tab.id === this.activeTabId) {
        this.cb.onFrame({ data: params.data, width: this.viewport.width, height: this.viewport.height })
      }
      try {
        await tab.cdp?.send('Page.screencastFrameAck', { sessionId: params.sessionId })
      } catch {
        /* page may have closed */
      }
    })
  }

  /**
   * Re-emit state and push one fresh frame of the active tab. Called when the
   * panel switches to this conversation/tab, since the screencast only pushes on
   * change — without this the canvas would keep showing the previous page.
   */
  async refreshView(): Promise<void> {
    this.emitState()
    const tab = this.activeTab()
    if (!tab) return
    if (tab.device) {
      try {
        const data = await tab.device.screenshot()
        this.cb.onFrame({ data, width: 0, height: 0, mime: 'image/png' })
      } catch {
        /* device busy — the next streamed frame will repaint */
      }
      return
    }
    if (!tab.page) return
    try {
      const buf = await tab.page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY })
      this.cb.onFrame({ data: buf.toString('base64'), width: this.viewport.width, height: this.viewport.height })
    } catch {
      /* page busy/navigating — the next screencast frame will repaint */
    }
  }

  private emitState(): void {
    const active = this.activeTab()
    const tabs = this.tabsInfo()
    if (!active) {
      this.cb.onState({ ...EMPTY_STATE, tabs })
      return
    }
    this.cb.onState({
      url: active.url,
      title: active.title,
      loading: active.loading,
      canGoBack: active.canGoBack,
      canGoForward: active.canGoForward,
      launched: true,
      tabs,
      androidSize: active.device ? active.device.screenSize : undefined
    })
  }

  private async applyViewport(page: Page | null): Promise<void> {
    if (!page) return // Android tabs use the device's own screen size.
    try {
      await page.setViewportSize(this.viewport)
    } catch {
      /* page busy */
    }
  }

  /**
   * Resize pages to match the panel (CSS px). The page reflows to the new size —
   * this is what lets the user change the rendered "screen format" by dragging
   * the splitter. Frames keep their 2× crispness.
   */
  async setViewport(width: number, height: number): Promise<void> {
    const w = Math.max(320, Math.min(MAX_FRAME.width, Math.round(width)))
    const h = Math.max(240, Math.min(MAX_FRAME.height, Math.round(height)))
    if (w === this.viewport.width && h === this.viewport.height) return
    this.viewport = { width: w, height: h }
    const page = this.activeTab()?.page
    if (!page) return
    await this.applyViewport(page)
    await this.refreshView()
  }

  // ---- select-on-page (element picker) ----

  private onPick(page: Page, data: Omit<PickedElement, 'tabId' | 'tabName'>): void {
    const tab = [...this.tabs.values()].find((t) => t.page === page)
    this.cb.onPicked({ ...data, tabId: tab?.id ?? '', tabName: tab ? tabName(tab) : '' })
  }

  async setSelectMode(on: boolean): Promise<void> {
    this.selectMode = on
    const page = this.activeTab()?.page
    if (page) await applyPageSelectMode(page, on)
  }

  private async reapplySelectMode(): Promise<void> {
    const page = this.activeTab()?.page
    if (page) await syncSelectMode(page, this.selectMode)
  }

  async forwardInput(ev: BrowserInput): Promise<void> {
    const tab = this.activeTab()
    if (!tab) return
    if (tab.device) return forwardAndroidInput(tab.device, ev)
    if (tab.page) await forwardPageInput(tab.page, tab.cdp, ev, this.viewport)
  }

  // ---- methods used by the agent's MCP browser tools (act on the active tab) ----

  async navigate(url: string): Promise<string> {
    // Always load into a web tab — never into the Stitch design preview / Android.
    const page = await this.ensureWebPage()
    const tab = this.activeTab()!
    this.setLoading(tab, true) // immediate spinner, before the navigation commits
    await gotoUrl(page, url)
    await this.updateTabMeta(tab)
    return `Navegou para ${page.url()} — "${tab.title}" (aba: "${tabName(tab)}").`
  }

  async back(): Promise<void> {
    const tab = this.activeTab()
    if (!tab) return
    if (tab.device) return void tab.device.back().catch(() => undefined)
    this.setLoading(tab, true)
    await tab.page?.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
    await this.updateTabMeta(tab)
  }

  async forward(): Promise<void> {
    const tab = this.activeTab()
    if (!tab || tab.device) return // no "forward" on a device
    this.setLoading(tab, true)
    await tab.page?.goForward({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
    await this.updateTabMeta(tab)
  }

  async reload(): Promise<void> {
    const tab = this.activeTab()
    if (!tab) return
    if (tab.device) return void tab.device.home().catch(() => undefined) // Home as a soft "reset"
    this.setLoading(tab, true)
    await tab.page?.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
    await this.updateTabMeta(tab)
  }

  async snapshot(): Promise<string> {
    const page = await this.activePage()
    const tab = this.activeTab()!
    return pageSnapshot(page, tabName(tab), tab.id)
  }

  async screenshot(): Promise<string> {
    return pageScreenshot(await this.activePage())
  }

  async clickSelector(selector: string): Promise<string> {
    return pageClick(await this.activePage(), selector)
  }

  async typeText(selector: string | undefined, text: string): Promise<string> {
    return fillOrType(await this.activePage(), selector, text)
  }

  async getText(selector: string | undefined): Promise<string> {
    return readText(await this.activePage(), selector)
  }

  async evaluate(expression: string): Promise<string> {
    return evaluateExpression(await this.activePage(), expression)
  }

  async close(): Promise<void> {
    // Stop any Android emulators/devices we booted before tearing down Chromium.
    for (const tab of this.tabs.values()) {
      if (tab.device) await tab.device.stop().catch(() => undefined)
    }
    try {
      // Persistent context owns the browser process — closing it tears everything down.
      await this.context?.close()
      await this.browser?.close()
    } catch {
      /* ignore */
    }
    this.browser = null
    this.context = null
    this.tabs.clear()
    this.activeTabId = null
    this.emitState()
  }
}
