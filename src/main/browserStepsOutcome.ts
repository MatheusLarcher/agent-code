import type { Page } from 'playwright'
import type { Outcome } from './browserStepsMatch'

/** Result detection for browser_run_steps: expect text, invalid fields, navigation. */

export const POLL_MS = 150
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Probe {
  text: boolean
  invalid: string[]
}

/** Starts watching for validation failures; returns the URL to compare against. */
export async function arm(page: Page): Promise<string> {
  await page
    .evaluate(() => {
      const w = window as unknown as { __acInvalid?: string[]; __acArmed?: boolean }
      w.__acInvalid = []
      if (!w.__acArmed) {
        w.__acArmed = true
        // Native validation fires 'invalid' on each rejected control at submit time.
        document.addEventListener(
          'invalid',
          (e) => {
            const t = e.target as HTMLElement
            ;(w.__acInvalid ??= []).push(t.dataset?.acRef || t.getAttribute('name') || t.id || t.tagName.toLowerCase())
          },
          true
        )
      }
      // aria-invalid already present doesn't count; only what appears after this.
      for (const e of document.querySelectorAll<HTMLElement>('[aria-invalid=true]')) e.dataset.acWasInvalid = '1'
    })
    .catch(() => undefined)
  return page.url()
}

function probe(page: Page, expect: string | undefined): Promise<Probe | null> {
  return page
    .evaluate((exp) => {
      const n = (s: string): string =>
        s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
      const inv = [...((window as unknown as { __acInvalid?: string[] }).__acInvalid ?? [])]
      for (const e of document.querySelectorAll<HTMLElement>('[aria-invalid=true]')) {
        if (!e.dataset.acWasInvalid) inv.push(e.dataset.acRef || e.getAttribute('name') || e.id || e.tagName.toLowerCase())
      }
      const text = !!exp && n(document.body?.innerText || '').includes(n(exp))
      return { text, invalid: [...new Set(inv)] }
    }, expect ?? '')
    .catch(() => null)
}

/**
 * First of: expect text, invalid fields, navigation, timeout. With an expect
 * text, navigation alone doesn't end the wait (thank-you pages load after it).
 */
export async function waitOutcome(
  page: Page,
  armedUrl: string,
  expect: string | undefined,
  ms: number,
  callEnd: number
): Promise<{ outcome: Outcome; invalid: string[] }> {
  const end = Math.min(Date.now() + ms, callEnd)
  for (;;) {
    const p = await probe(page, expect)
    if (p?.text) return { outcome: 'expect', invalid: [] }
    if (p?.invalid.length) return { outcome: 'invalid', invalid: p.invalid }
    const moved = page.url() !== armedUrl
    if (moved && !expect) {
      await page.waitForLoadState('domcontentloaded', { timeout: Math.max(100, end - Date.now()) }).catch(() => undefined)
      return { outcome: 'navigated', invalid: [] }
    }
    if (Date.now() + POLL_MS > end) return { outcome: moved ? 'navigated' : 'timeout', invalid: [] }
    await sleep(POLL_MS)
  }
}

export function lineWith(page: Page, text: string): Promise<string> {
  return page
    .evaluate((t) => {
      const n = (s: string): string =>
        s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
      const lines = (document.body?.innerText || '').split('\n')
      return (lines.find((l) => n(l).includes(n(t))) || t).replace(/\s+/g, ' ').trim().slice(0, 200)
    }, text)
    .catch(() => text)
}
