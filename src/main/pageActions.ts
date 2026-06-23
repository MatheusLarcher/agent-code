import { clipboard } from 'electron'
import type { Page, CDPSession } from 'playwright'
import type { BrowserInput } from '../shared/ipc'

/**
 * Pure operations on a Playwright page — the web half of a preview tab. Kept out
 * of BrowserController so the controller stays focused on tab/stream lifecycle.
 */

/** Treat as absolute if it has a scheme; otherwise assume https. */
export function absolutize(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url
  if (/^(data|about|blob|file):/i.test(url)) return url
  return `https://${url}`
}

/** Navigate the page to a (possibly scheme-less) URL. */
export async function gotoUrl(page: Page, url: string): Promise<void> {
  await page.goto(absolutize(url), { waitUntil: 'domcontentloaded', timeout: 45000 })
}

/** Structured snapshot (title, url, visible text, interactive elements) as JSON. */
export async function pageSnapshot(page: Page, tabLabel: string, tabId: string): Promise<string> {
  const digest = await page.evaluate(() => {
    const pick = (el: Element): Record<string, string> => ({
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
  return JSON.stringify({ tab: tabLabel, tabId, ...digest }, null, 2)
}

/** PNG screenshot of the page as base64. */
export async function pageScreenshot(page: Page): Promise<string> {
  const buf = await page.screenshot({ type: 'png' })
  return buf.toString('base64')
}

export async function clickSelector(page: Page, selector: string): Promise<string> {
  await page.locator(selector).first().click({ timeout: 15000 })
  return `Clicou em ${selector}`
}

export async function fillOrType(page: Page, selector: string | undefined, text: string): Promise<string> {
  if (selector) {
    await page.locator(selector).first().fill(text, { timeout: 15000 })
    return `Preencheu ${selector}`
  }
  await page.keyboard.type(text)
  return `Digitou o texto`
}

export async function readText(page: Page, selector: string | undefined): Promise<string> {
  if (selector) {
    const t = await page.locator(selector).first().innerText({ timeout: 15000 })
    return t.slice(0, 8000)
  }
  return (await page.evaluate(() => document.body?.innerText || '')).slice(0, 8000)
}

export async function evaluateExpression(page: Page, expression: string): Promise<string> {
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

/** Turn the in-page element picker on/off (hides the highlight box when off). */
export async function setSelectMode(page: Page, on: boolean): Promise<void> {
  await page
    .evaluate((v: boolean) => {
      ;(window as unknown as { __agentSelectMode: boolean }).__agentSelectMode = v
      const b = document.getElementById('__agent_highlight__')
      if (b && !v) b.style.display = 'none'
    }, on)
    .catch(() => undefined)
}

/** Re-assert the current select-mode flag (e.g. after a navigation). */
export async function syncSelectMode(page: Page, on: boolean): Promise<void> {
  try {
    await page.evaluate((v: boolean) => {
      ;(window as unknown as { __agentSelectMode: boolean }).__agentSelectMode = v
    }, on)
  } catch {
    /* navigation in flight */
  }
}

/**
 * Forward a panel input event (normalized coords) onto the page. Mouse press/
 * release are sent separately (`down`/`up`) so dragging works — text selection,
 * sliders, drag-and-drop. The legacy `click` is ignored here (Android uses it);
 * down+up already produce a click on the web page.
 */
export async function forwardPageInput(
  page: Page,
  cdp: CDPSession | null,
  ev: BrowserInput,
  vp: { width: number; height: number }
): Promise<void> {
  const x = (n: number): number => Math.max(0, Math.min(vp.width, n * vp.width))
  const y = (n: number): number => Math.max(0, Math.min(vp.height, n * vp.height))
  try {
    if (ev.type === 'move') {
      await page.mouse.move(x(ev.nx), y(ev.ny))
    } else if (ev.type === 'down') {
      await page.mouse.move(x(ev.nx), y(ev.ny))
      await page.mouse.down({ button: ev.button })
    } else if (ev.type === 'up') {
      await page.mouse.move(x(ev.nx), y(ev.ny))
      await page.mouse.up({ button: ev.button })
    } else if (ev.type === 'wheel') {
      await cdp?.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: x(ev.nx),
        y: y(ev.ny),
        deltaX: ev.dx,
        deltaY: ev.dy
      })
    } else if (ev.type === 'key') {
      await forwardKey(page, ev)
    }
  } catch {
    /* ignore transient input errors during navigation */
  }
}

/**
 * Forward a key event, bridging the OS clipboard for the combos a normal browser
 * supports: paste inserts the system clipboard, copy/cut read the page selection
 * into it. Other Ctrl/Cmd combos (select-all, undo, …) are passed through.
 */
async function forwardKey(page: Page, ev: Extract<BrowserInput, { type: 'key' }>): Promise<void> {
  const mod = !!(ev.ctrl || ev.meta)
  const lower = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key

  if (mod && lower === 'v') {
    const text = clipboard.readText()
    if (text) await page.keyboard.insertText(text)
    return
  }
  if (mod && (lower === 'c' || lower === 'x')) {
    const sel = await page.evaluate(() => {
      const ae = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
        return (ae.value || '').substring(ae.selectionStart || 0, ae.selectionEnd || 0)
      }
      return window.getSelection?.()?.toString() || ''
    })
    if (sel) {
      clipboard.writeText(sel)
      if (lower === 'x') await page.keyboard.insertText('') // delete the selection (cut)
    }
    return
  }
  if (mod) {
    const parts: string[] = []
    if (ev.ctrl) parts.push('Control')
    if (ev.meta) parts.push('Meta')
    if (ev.alt) parts.push('Alt')
    if (ev.shift) parts.push('Shift')
    parts.push(lower)
    await page.keyboard.press(parts.join('+'))
    return
  }
  if (ev.text && ev.text.length === 1) await page.keyboard.type(ev.text)
  else await page.keyboard.press(ev.key)
}
