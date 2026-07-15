// End-to-end smoke test for browser launch visibility and real history controls.
import { _electron as electron } from 'playwright'

const page = (title) => 'data:text/html,' + encodeURIComponent(`<title>${title}</title><h1>${title}</h1>`)
const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.evaluate(() => {
    const now = Date.now()
    localStorage.setItem('agentcode.conversations.v1', JSON.stringify([{
      id: 'browser-regression', title: 'Browser regression', cwd: '.', model: 'claude-opus-4-8',
      sdkSessionId: null, messages: [], tokens: { context: 0, output: 0, cost: 0 }, createdAt: now, updatedAt: now
    }]))
    localStorage.setItem('agentcode.ui.v1', JSON.stringify({ activeId: 'browser-regression', browserMinimized: false, browserWidth: 720 }))
  })
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('.tab-new')
  await win.waitForTimeout(600)

  await win.evaluate(() => window.api.setActiveBrowser('browser-regression'))
  await win.evaluate(() => window.api.newTab('file', 'C:/tmp/example.pdf'))
  await win.evaluate((url) => window.api.navigate(url), page('FIRST'))
  await win.waitForSelector('.browser-canvas:not(.hidden)')
  await win.evaluate((url) => window.api.navigate(url), page('SECOND'))
  await win.waitForFunction(() => {
    const buttons = document.querySelectorAll('.browser-toolbar .nav-btn')
    return buttons.length >= 3 && !buttons[1].disabled && buttons[2].disabled
  })
  await win.locator('.browser-toolbar .nav-btn').nth(1).click()
  await win.waitForFunction(() => !document.querySelectorAll('.browser-toolbar .nav-btn')[2].disabled)
  console.log('[browser-regression-probe] file-to-web, visible canvas and history controls passed')
} finally {
  await app.close()
}
