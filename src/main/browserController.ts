import type { Browser, BrowserContext, Page, CDPSession } from 'playwright'
import type { BrowserFrame, BrowserInput, BrowserState, PickedElement } from '../shared/ipc'

const VIEWPORT = { width: 1280, height: 800 }

interface BrowserCallbacks {
  onFrame: (frame: BrowserFrame) => void
  onState: (state: BrowserState) => void
  onPicked: (el: PickedElement) => void
}

// Injected into every page: a hover-highlight + click-capture element picker,
// gated by window.__agentSelectMode and reporting via window.__agentPick.
const PICKER_SCRIPT = String.raw`(() => {
  if (window.__agentPickerInstalled) return;
  window.__agentPickerInstalled = true;
  const HL = '__agent_highlight__';
  function box() {
    let b = document.getElementById(HL);
    if (!b) {
      b = document.createElement('div'); b.id = HL;
      Object.assign(b.style, { position:'fixed', zIndex:2147483647, pointerEvents:'none',
        border:'2px solid #d97757', background:'rgba(217,119,87,0.14)', borderRadius:'3px', display:'none' });
      (document.documentElement || document.body).appendChild(b);
    }
    return b;
  }
  function sel(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = []; let e = el;
    while (e && e.nodeType === 1 && parts.length < 5) {
      let s = e.tagName.toLowerCase();
      if (e.classList && e.classList.length) s += '.' + [...e.classList].slice(0,2).map(c => CSS.escape(c)).join('.');
      const sib = e.parentElement ? [...e.parentElement.children].filter(x => x.tagName === e.tagName) : [];
      if (sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(e) + 1) + ')';
      parts.unshift(s); e = e.parentElement;
    }
    return parts.join(' > ');
  }
  function cls(el) { const c = el.className; return (c && c.baseVal !== undefined ? c.baseVal : c) || ''; }
  function onMove(ev) {
    if (!window.__agentSelectMode) return;
    const el = ev.target; if (!el || el.id === HL) return;
    const r = el.getBoundingClientRect(); const b = box();
    b.style.display='block'; b.style.left=r.left+'px'; b.style.top=r.top+'px';
    b.style.width=r.width+'px'; b.style.height=r.height+'px';
  }
  function onClick(ev) {
    if (!window.__agentSelectMode) return;
    ev.preventDefault(); ev.stopPropagation();
    const el = ev.target;
    const data = { selector: sel(el), tagName: el.tagName.toLowerCase(), id: el.id || '',
      classes: cls(el), text: (el.innerText || el.textContent || '').trim().slice(0,2000),
      html: el.outerHTML.slice(0,4000), url: location.href };
    if (window.__agentPick) window.__agentPick(data);
  }
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('mousedown', e => { if (window.__agentSelectMode) { e.preventDefault(); e.stopPropagation(); } }, true);
})();`

export class BrowserController {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private cdp: CDPSession | null = null
  private selectMode = false

  constructor(private readonly cb: BrowserCallbacks) {}

  get isLaunched(): boolean {
    return this.page !== null
  }

  async ensureLaunched(): Promise<Page> {
    if (this.page) return this.page
    const { chromium } = await import('playwright')
    // Headless so no real Chromium window pops up on the machine — the page is
    // streamed to the in-app canvas via CDP screencast (see startScreencast).
    this.browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-default-browser-check']
    })
    this.context = await this.browser.newContext({ viewport: VIEWPORT })
    await this.context.addInitScript(PICKER_SCRIPT)
    this.page = await this.context.newPage()
    await this.page.exposeFunction('__agentPick', (data: PickedElement) => this.cb.onPicked(data))

    this.page.on('framenavigated', (frame) => {
      if (frame === this.page?.mainFrame()) {
        void this.reapplySelectMode()
        this.emitState()
      }
    })
    this.page.on('load', () => this.emitState())

    await this.startScreencast()
    this.emitState()
    return this.page
  }

  private async startScreencast(): Promise<void> {
    if (!this.context || !this.page) return
    this.cdp = await this.context.newCDPSession(this.page)
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: 1
    })
    this.cdp.on('Page.screencastFrame', async (params: { data: string; sessionId: number }) => {
      this.cb.onFrame({ data: params.data, width: VIEWPORT.width, height: VIEWPORT.height })
      try {
        await this.cdp?.send('Page.screencastFrameAck', { sessionId: params.sessionId })
      } catch {
        /* page may have closed */
      }
    })
  }

  private async reapplySelectMode(): Promise<void> {
    if (!this.page) return
    try {
      await this.page.evaluate((v: boolean) => {
        ;(window as unknown as { __agentSelectMode: boolean }).__agentSelectMode = v
      }, this.selectMode)
    } catch {
      /* navigation in flight */
    }
  }

  private emitState(): void {
    const page = this.page
    if (!page) {
      this.cb.onState({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false, launched: false })
      return
    }
    page
      .title()
      .then((title) => {
        this.cb.onState({
          url: page.url(),
          title,
          loading: false,
          canGoBack: true,
          canGoForward: true,
          launched: true
        })
      })
      .catch(() => undefined)
  }

  async navigate(url: string): Promise<string> {
    const page = await this.ensureLaunched()
    const full = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`
    await page.goto(full, { waitUntil: 'domcontentloaded', timeout: 45000 })
    this.emitState()
    return `Navigated to ${page.url()} — "${await page.title()}"`
  }

  async back(): Promise<void> {
    await this.page?.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
    this.emitState()
  }

  async forward(): Promise<void> {
    await this.page?.goForward({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
    this.emitState()
  }

  async reload(): Promise<void> {
    await this.page?.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
    this.emitState()
  }

  async setSelectMode(on: boolean): Promise<void> {
    this.selectMode = on
    if (!this.page) return
    await this.page.evaluate(
      (v: boolean) => {
        ;(window as unknown as { __agentSelectMode: boolean }).__agentSelectMode = v
        const b = document.getElementById('__agent_highlight__')
        if (b && !v) b.style.display = 'none'
      },
      on
    )
  }

  async forwardInput(ev: BrowserInput): Promise<void> {
    const page = this.page
    if (!page) return
    const x = (n: number): number => Math.max(0, Math.min(VIEWPORT.width, n * VIEWPORT.width))
    const y = (n: number): number => Math.max(0, Math.min(VIEWPORT.height, n * VIEWPORT.height))
    try {
      if (ev.type === 'move') {
        await page.mouse.move(x(ev.nx), y(ev.ny))
      } else if (ev.type === 'click') {
        await page.mouse.click(x(ev.nx), y(ev.ny), { button: ev.button })
      } else if (ev.type === 'wheel') {
        await this.cdp?.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: x(ev.nx),
          y: y(ev.ny),
          deltaX: ev.dx,
          deltaY: ev.dy
        })
      } else if (ev.type === 'key') {
        if (ev.text && ev.text.length === 1) await page.keyboard.type(ev.text)
        else await page.keyboard.press(ev.key)
      }
    } catch {
      /* ignore transient input errors during navigation */
    }
  }

  // ---- Methods used by the agent's MCP browser tools ----

  async snapshot(): Promise<string> {
    const page = await this.ensureLaunched()
    const digest = await page.evaluate(() => {
      const pick = (el: Element) => ({
        tag: el.tagName.toLowerCase(),
        text: ((el as HTMLElement).innerText || (el as HTMLInputElement).value || '').trim().slice(0, 120),
        role: el.getAttribute('role') || '',
        name: el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || '',
        href: el.getAttribute('href') || ''
      })
      const sels = 'a,button,input,textarea,select,[role=button],[role=link],[role=tab]'
      const interactive = [...document.querySelectorAll(sels)].slice(0, 150).map(pick)
      return {
        title: document.title,
        url: location.href,
        text: document.body ? document.body.innerText.slice(0, 4000) : '',
        interactive
      }
    })
    return JSON.stringify(digest, null, 2)
  }

  async screenshot(): Promise<string> {
    const page = await this.ensureLaunched()
    const buf = await page.screenshot({ type: 'png' })
    return buf.toString('base64')
  }

  async clickSelector(selector: string): Promise<string> {
    const page = await this.ensureLaunched()
    await page.locator(selector).first().click({ timeout: 15000 })
    this.emitState()
    return `Clicked ${selector}`
  }

  async typeText(selector: string | undefined, text: string): Promise<string> {
    const page = await this.ensureLaunched()
    if (selector) {
      await page.locator(selector).first().fill(text, { timeout: 15000 })
      return `Filled ${selector}`
    }
    await page.keyboard.type(text)
    return `Typed text`
  }

  async getText(selector: string | undefined): Promise<string> {
    const page = await this.ensureLaunched()
    if (selector) {
      const t = await page.locator(selector).first().innerText({ timeout: 15000 })
      return t.slice(0, 8000)
    }
    return (await page.evaluate(() => document.body?.innerText || '')).slice(0, 8000)
  }

  async evaluate(expression: string): Promise<string> {
    const page = await this.ensureLaunched()
    const result = await page.evaluate((expr: string) => {
      // eslint-disable-next-line no-eval
      const v = eval(expr)
      try {
        return typeof v === 'string' ? v : JSON.stringify(v)
      } catch {
        return String(v)
      }
    }, expression)
    return String(result).slice(0, 8000)
  }

  async close(): Promise<void> {
    try {
      await this.browser?.close()
    } catch {
      /* ignore */
    }
    this.browser = null
    this.context = null
    this.page = null
    this.cdp = null
    this.emitState()
  }
}
