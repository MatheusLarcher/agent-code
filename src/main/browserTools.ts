import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { BrowserController } from './browserController'
import { MAX_EXPECT, MAX_STEPS, REF_RE, STEP_ACTIONS, resultText, stepProblem } from './browserStepsMatch'

type Text = { content: { type: 'text'; text: string }[] }
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] })

const stepTargetSchema = z.object({
  ref: z.string().regex(REF_RE).optional().describe('Ref (eN) from browser_form_fields.'),
  label: z.string().min(1).max(500).optional()
    .describe('Field label or radio option label; case/accent-insensitive, exact match wins over contains.'),
  text: z.string().min(1).max(500).optional().describe('Visible text of a button or link.')
})

export const browserStepSchema = z.object({
  action: z.enum(STEP_ACTIONS),
  target: stepTargetSchema.optional(),
  value: z.union([z.string().max(100_000), z.array(z.string().min(1).max(1_000)).min(1).max(100)]).optional()
    .describe('fill: text; select: option (array only for multi-select/multi combobox); radio group: option label; press: key or chord (Enter, Control+a); navigate: URL; wait_for: text that must appear.'),
  timeoutMs: z.number().int().min(100).max(30_000).optional().describe('How long to wait for the target (default 5000).')
}).superRefine((step, ctx) => {
  const problem = stepProblem(step)
  if (problem) ctx.addIssue({ code: 'custom', message: problem })
})

export const browserRunStepsShape = {
  steps: z.array(browserStepSchema).min(1).max(MAX_STEPS),
  expect: z.string().min(1).max(MAX_EXPECT).optional()
    .describe('Text that proves success (e.g. "Thanks for submitting"); ok requires it to appear.')
}

/**
 * Exposes the embedded Playwright browser to the agent as an in-process MCP
 * server. The browser is organized into **tabs**; there is always one active tab
 * and every tool below acts on it. Use browser_list_tabs / browser_new_tab /
 * browser_select_tab to manage tabs — but reuse the current tab by default.
 */
export function createBrowserMcpServer(
  browser: BrowserController
): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: 'browser',
    version: '1.0.0',
    tools: [
      tool(
        'browser_list_tabs',
        'List the preview tabs (id, name like "web - Site", url) and which one is active. Call this when you are unsure which tab you are controlling.',
        {},
        async () => text(browser.listTabsText())
      ),
      tool(
        'browser_new_tab',
        'Open a NEW preview tab and make it active. Only open a new tab when you genuinely need a separate page alongside the current one — otherwise reuse the current tab with browser_navigate. Only "web" tabs are supported right now.',
        {
          kind: z.enum(['web', 'android', 'iphone']).optional().describe('Tab kind (default "web"; others not implemented yet).'),
          url: z.string().optional().describe('Optional URL to open immediately in the new tab.')
        },
        async ({ kind, url }) => text(await browser.newTab(kind ?? 'web', url))
      ),
      tool(
        'browser_select_tab',
        'Switch the active tab (the one being controlled and shown to the user) by its id, from browser_list_tabs.',
        { tabId: z.string().describe('Id of the tab to activate.') },
        async ({ tabId }) => text(await browser.selectTab(tabId))
      ),
      tool(
        'browser_close_tab',
        'Close a preview tab by its id.',
        { tabId: z.string().describe('Id of the tab to close.') },
        async ({ tabId }) => text(await browser.closeTab(tabId))
      ),
      tool(
        'browser_navigate',
        'Open a URL in the ACTIVE tab (reusing it — does NOT open a new tab). Launches the browser if needed.',
        { url: z.string().describe('The URL to open (https:// is added if missing).') },
        async ({ url }) => text(await browser.navigate(url))
      ),
      tool(
        'browser_form_fields',
        'FIRST step to interact with a page (forms, clicks, choices). Lists the visible controls of the ACTIVE tab, one line each: `eN type[*=required] "label" [options] = "value"`; radio groups show each option as Label=eN, checkboxes = on/off, passwords are masked; then buttons/links; last line `url: … | title: …`. Refs stay stable across reads. Then do everything in ONE browser_run_steps, targeting by label/text. Reads the main frame only (not iframes or shadow DOM): if it comes back empty or useless, or the page is a canvas, use browser_snapshot/browser_screenshot.',
        {},
        async () => text(await browser.formFields())
      ),
      tool(
        'browser_run_steps',
        'Run ALL the steps of an interaction on the ACTIVE tab in one call (after browser_form_fields). Actions: fill, select, check, uncheck, click, press, wait_for, navigate. Target by label (field or radio option label) or text (button/link text) — case/accent-insensitive, exact beats contains — or by ref from browser_form_fields. Each target is resolved right before its step and polled up to timeoutMs (default 5000), so fields that only appear later (City after State) work. Radio group: select with the group label and value = option, or check the option label. Stops at the first failure or ambiguous target: failedStep {i (0-based), action, target, error, candidates}. After clicks and at the end it waits for the first of: expect text, navigation, invalid fields, timeout. Returns JSON {ok, done, total, failedStep?, outcome, message?, invalid?, url} then the page state (form fields + visible alerts). Call again only if it stopped, starting from that state. Fall back to browser_snapshot/browser_screenshot for canvas pages, empty form_fields or ambiguous results.',
        browserRunStepsShape,
        async ({ steps, expect }) => text(resultText(await browser.runSteps(steps, expect)))
      ),
      tool(
        'browser_snapshot',
        'Structured snapshot of the ACTIVE tab: its name, title, URL, visible text, and interactive elements. Use this to understand the page (and confirm which tab you are on) before acting.',
        {},
        async () => text(await browser.snapshot())
      ),
      tool(
        'browser_screenshot',
        'Capture a PNG screenshot of the active tab and return it as an image.',
        {},
        async () => {
          const data = await browser.screenshot()
          return { content: [{ type: 'image' as const, data, mimeType: 'image/png' }] }
        }
      ),
      tool(
        'browser_click',
        'Click an element in the active tab identified by a CSS selector.',
        { selector: z.string().describe('CSS selector of the element to click.') },
        async ({ selector }) => text(await browser.clickSelector(selector))
      ),
      tool(
        'browser_type',
        'Type text in the active tab. If a selector is given, fill that input/textarea; otherwise type into the focused element.',
        {
          text: z.string().describe('The text to type.'),
          selector: z.string().optional().describe('Optional CSS selector of the field to fill.')
        },
        async ({ text: value, selector }) => text(await browser.typeText(selector, value))
      ),
      tool(
        'browser_get_text',
        'Read text content from the active tab, optionally scoped to a CSS selector.',
        { selector: z.string().optional().describe('Optional CSS selector to scope the read.') },
        async ({ selector }) => text(await browser.getText(selector))
      ),
      tool(
        'browser_evaluate',
        'Evaluate a JavaScript expression in the active tab and return the result (stringified).',
        { expression: z.string().describe('A JavaScript expression to evaluate in the page context.') },
        async ({ expression }) => text(await browser.evaluate(expression))
      ),
      tool('browser_back', 'Go back one entry in the active tab history.', {}, async () => {
        await browser.back()
        return text('Voltou uma página.')
      }),
      tool('browser_reload', 'Reload the active tab.', {}, async () => {
        await browser.reload()
        return text('Recarregou.')
      })
    ]
  })
}
