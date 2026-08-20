// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WireMdMockupRenderer } from './wiremdRenderer'

const SOURCE = `# Atendimento
::: columns-2
::: column
## Fila
12 chamados
:::
::: column
## SLA
((92%)){success}
:::
:::`

describe('WireMD preview in Chromium', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  }, 20_000)

  afterAll(async () => {
    await browser?.close()
  })

  it('loads the sanitized document in one sandboxed srcdoc frame without network', async () => {
    const artifact = await new WireMdMockupRenderer().render(SOURCE)
    const page = await browser.newPage()
    const requests: string[] = []
    page.on('request', (request) => requests.push(request.url()))
    await page.setContent(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; frame-src 'self' blob:; style-src 'unsafe-inline'"></head><body></body></html>`)
    await page.evaluate((html) => {
      const frame = document.createElement('iframe')
      frame.title = 'Atendimento'
      frame.setAttribute('sandbox', '')
      frame.setAttribute('referrerpolicy', 'no-referrer')
      frame.srcdoc = html
      document.body.append(frame)
    }, artifact.html)

    await expect.poll(() => page.frames().length).toBe(2)
    const preview = page.frames()[1]
    await expect.poll(() => preview.locator('body.wmd-root.wmd-clean').count()).toBe(1)
    expect(await preview.locator('h1').textContent()).toContain('Atendimento')
    expect(await preview.locator('script, iframe, object, embed').count()).toBe(0)
    expect(requests).toEqual([])
    await page.close()
  }, 20_000)

  it('keeps content taller than the reference viewport scrollable inside the preview', async () => {
    const longSource = `# Lista longa\n## Itens\n${Array.from({ length: 45 }, (_, index) => `- Item ${index + 1}`).join('\n')}`
    const artifact = await new WireMdMockupRenderer().render(longSource)
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    const page = await browser.newPage()
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>
      <div class="ui-mockup-viewport"><div class="ui-mockup-stage" style="width:563px;height:352px">
      <iframe title="Lista longa" sandbox="" referrerpolicy="no-referrer" width="1024" height="640"
        style="transform:scale(.55)"></iframe></div></div></body></html>`)
    await page.locator('iframe').evaluate((frame, html) => {
      ;(frame as HTMLIFrameElement).srcdoc = html
    }, artifact.html)
    await expect.poll(() => page.frames().length).toBe(2)

    const frameElement = page.locator('iframe')
    expect(await frameElement.evaluate((frame) => getComputedStyle(frame).pointerEvents)).toBe('auto')
    const preview = page.frames()[1]
    const dimensions = await preview.evaluate(() => ({
      clientHeight: document.documentElement.clientHeight,
      scrollHeight: document.documentElement.scrollHeight
    }))
    expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight)
    expect(await preview.evaluate(() => {
      document.documentElement.scrollTop = 200
      document.body.scrollTop = 200
      return Math.max(document.documentElement.scrollTop, document.body.scrollTop)
    })).toBeGreaterThan(0)
    await page.close()
  }, 20_000)
})
