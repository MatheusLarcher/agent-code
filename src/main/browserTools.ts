import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BrowserController } from './browserController'

type Text = { content: { type: 'text'; text: string }[] }
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] })

/**
 * Exposes the embedded Playwright browser to the agent as an in-process MCP
 * server. When the agent calls one of these tools, the page is driven and the
 * live view is streamed into the app — this is how "the agent renders the
 * browser" inside the UI.
 */
export function createBrowserMcpServer(
  browser: BrowserController
): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: 'browser',
    version: '1.0.0',
    tools: [
      tool(
        'browser_navigate',
        'Open a URL in the embedded browser. Launches the browser if needed.',
        { url: z.string().describe('The URL to open (https:// is added if missing).') },
        async ({ url }) => text(await browser.navigate(url))
      ),
      tool(
        'browser_snapshot',
        'Get a structured snapshot of the current page: title, URL, visible text, and a list of interactive elements with selectors hints. Use this to understand the page before acting.',
        {},
        async () => text(await browser.snapshot())
      ),
      tool(
        'browser_screenshot',
        'Capture a PNG screenshot of the current page and return it as an image.',
        {},
        async () => {
          const data = await browser.screenshot()
          return { content: [{ type: 'image' as const, data, mimeType: 'image/png' }] }
        }
      ),
      tool(
        'browser_click',
        'Click an element on the page identified by a CSS selector.',
        { selector: z.string().describe('CSS selector of the element to click.') },
        async ({ selector }) => text(await browser.clickSelector(selector))
      ),
      tool(
        'browser_type',
        'Type text. If a selector is given, fill that input/textarea; otherwise type into the focused element.',
        {
          text: z.string().describe('The text to type.'),
          selector: z.string().optional().describe('Optional CSS selector of the field to fill.')
        },
        async ({ text: value, selector }) => text(await browser.typeText(selector, value))
      ),
      tool(
        'browser_get_text',
        'Read text content from the page, optionally scoped to a CSS selector.',
        { selector: z.string().optional().describe('Optional CSS selector to scope the read.') },
        async ({ selector }) => text(await browser.getText(selector))
      ),
      tool(
        'browser_evaluate',
        'Evaluate a JavaScript expression in the page and return the result (stringified).',
        { expression: z.string().describe('A JavaScript expression to evaluate in the page context.') },
        async ({ expression }) => text(await browser.evaluate(expression))
      ),
      tool('browser_back', 'Go back one entry in browser history.', {}, async () => {
        await browser.back()
        return text('Went back.')
      }),
      tool('browser_reload', 'Reload the current page.', {}, async () => {
        await browser.reload()
        return text('Reloaded.')
      })
    ]
  })
}
