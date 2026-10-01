import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { windowsControl, type WindowsControlScope, type WindowsControlService } from './service'

type ToolResult = { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }

const result = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
})

export const WINDOWS_CONTROL_HINT = `## Controle de aplicativos do Windows
Você possui ferramentas windows_* para controlar aplicativos desktop quando o usuário habilita “Permitir controle do Windows”. Não as use para editar código ou rodar comandos.
- Ajustes do sistema (tema, som, energia, rede, serviços, apps padrão, instalar programa…): faça primeiro por comando (PowerShell, registro, \`winget\`, \`start ms-settings:<página>\`); interface só se não houver comando ou se o usuário pedir para ver. Os comandos passam pela aprovação normal.
- Para mexer num programa: windows_list_windows → windows_form_fields → UM windows_run_steps com todos os passos, alvo por nome. Só chame de novo se o run_steps parar, partindo do state devolvido (sem novo windows_get_state).
- Não use atalhos de teclado como caminho principal (nem todo programa tem); press só quando nenhum controle resolver.
- Alternativa: windows_get_state com screenshot, coordenadas e ações isoladas (windows_click, windows_click_element, windows_fill, windows_set_value, windows_secondary_action…) para app sem acessibilidade, canvas, ou quando windows_form_fields vier vazio/inútil. Observe de novo depois de clique em botão, abertura ou fechamento de diálogo, ou erro; windows_set_value e toggle/select/focus podem ser encadeadas sem novo windows_get_state.
- Para texto em campo avulso use windows_fill (confere o valor final); windows_type_text e windows_press_key só para atalhos e teclas especiais.
- Nunca invente windowId. Se a resposta trouxer targetWindowId diferente do windowId usado (ex.: diálogo modal), use esse windowId dali em diante.
- Se a permissão estiver desligada, explique que ela deve ser ativada em Configurações; não tente contornar o bloqueio.`

const TARGETED_ACTIONS = new Set(['fill', 'click', 'toggle', 'select', 'expand', 'focus'])
const VALUE_ACTIONS = new Set(['fill', 'select', 'press'])

const stepTargetSchema = z.object({
  index: z.number().int().min(0).max(9_999).optional().describe('Index from windows_form_fields/windows_get_state.'),
  name: z.string().min(1).max(500).optional().describe('Control name, case/accent-insensitive; exact match wins over contains.'),
  automationId: z.string().min(1).max(500).optional(),
  type: z.string().min(1).max(80).optional().describe('Control type to disambiguate, e.g. Button, Edit, MenuItem.'),
  gone: z.string().min(1).max(500).optional().describe('wait_for only: name that must disappear.')
})

const runStepSchema = z.object({
  action: z.enum(['fill', 'click', 'toggle', 'select', 'expand', 'focus', 'press', 'wait_for']),
  target: stepTargetSchema.optional(),
  value: z.string().max(100_000).optional()
    .describe('fill: text; select: item name; press: key or chord (Return, Control+s); toggle: optional on/off.'),
  timeoutMs: z.number().int().min(100).max(30_000).optional().describe('Per-step wait (default 5000).')
}).superRefine((step, ctx) => {
  const target = step.target
  if (TARGETED_ACTIONS.has(step.action) && target?.index === undefined && !target?.name && !target?.automationId)
    ctx.addIssue({ code: 'custom', path: ['target'], message: `${step.action} needs target.index, target.name or target.automationId` })
  if (VALUE_ACTIONS.has(step.action) && (step.value === undefined || (step.action !== 'fill' && step.value === '')))
    ctx.addIssue({ code: 'custom', path: ['value'], message: `${step.action} needs value` })
  if (step.action === 'wait_for' && !target?.name && !target?.gone)
    ctx.addIssue({ code: 'custom', path: ['target'], message: 'wait_for needs target.name or target.gone' })
  if (step.action === 'toggle' && step.value !== undefined && step.value !== 'on' && step.value !== 'off')
    ctx.addIssue({ code: 'custom', path: ['value'], message: "toggle value must be 'on' or 'off'" })
})

export function createWindowsControlMcpServer(
  scope: WindowsControlScope = windowsControl.createScope(),
  service: WindowsControlService = windowsControl
): ReturnType<typeof createSdkMcpServer> {
  const run = <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => scope.run(operation)
  return createSdkMcpServer({
    name: 'windows',
    version: '1.0.0',
    tools: [
      tool('windows_list_windows', 'List targetable open Windows windows. Returns stable windowId values, titles, apps, bounds and whether each can be captured.', {}, async () =>
        result(await run((signal) => service.listWindows(signal)))),
      tool('windows_list_apps', 'List running Windows apps that currently have targetable windows.', {}, async () =>
        result(await run((signal) => service.listApps(signal)))),
      tool(
        'windows_launch_app',
        'Launch an installed Windows app by executable name/path or shell identifier. Poll windows_list_windows afterwards and select exactly one returned window.',
        {
          app: z.string().min(1).max(32_000).describe('Executable name/path or Windows shell app identifier.'),
          arguments: z.array(z.string().max(2_000)).max(40).optional().describe('Optional application arguments.')
        },
        async ({ app, arguments: args }) => result(await run((signal) => service.launchApp(app, args ?? [], signal)))
      ),
      tool(
        'windows_activate_window',
        'Bring one exact window returned by windows_list_windows to the foreground.',
        { windowId: z.string().regex(/^\d+$/) },
        async ({ windowId }) => result(await run((signal) => service.activateWindow(windowId, signal)))
      ),
      tool(
        'windows_get_state',
        'Observe one exact window. Returns a screenshot id for coordinate actions and/or a UI Automation tree with element indexes. Observe again after actions that may open or close windows, or after an error.',
        {
          windowId: z.string().regex(/^\d+$/),
          includeScreenshot: z.boolean().optional().describe('Capture the window image (default true).'),
          includeText: z.boolean().optional().describe('Read the UI Automation tree (default true).'),
          maxDepth: z.number().int().min(1).max(20).optional(),
          maxElements: z.number().int().min(1).max(1_000).optional()
        },
        async ({ windowId, includeScreenshot, includeText, maxDepth, maxElements }) => {
          const state = await run((signal) => service.getWindowState(windowId, {
            includeScreenshot: includeScreenshot ?? true,
            includeText: includeText ?? true,
            maxDepth,
            maxElements
          }, signal))
          const summary = {
            window: state.window,
            accessibility: state.accessibility,
            screenshot: state.screenshot
              ? { id: state.screenshot.id, width: state.screenshot.width, height: state.screenshot.height }
              : undefined
          }
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(summary, null, 2) },
              ...(state.screenshot
                ? [{ type: 'image' as const, data: state.screenshot.data, mimeType: state.screenshot.mimeType }]
                : [])
            ]
          }
        }
      ),
      tool(
        'windows_click_element',
        'Invoke or click one elementIndex from the latest UI Automation state for this window. The index is accepted while that element is unchanged; otherwise call windows_get_state again.',
        { windowId: z.string().regex(/^\d+$/), elementIndex: z.number().int().min(0).max(9_999) },
        async ({ windowId, elementIndex }) => result(await run((signal) => service.clickElement(windowId, elementIndex, signal)))
      ),
      tool(
        'windows_click',
        'Click screenshot-relative coordinates in one window. screenshotId must come from its latest windows_get_state result.',
        {
          windowId: z.string().regex(/^\d+$/),
          screenshotId: z.string().uuid(),
          x: z.number().min(0),
          y: z.number().min(0),
          button: z.enum(['left', 'right', 'middle']).optional(),
          clickCount: z.number().int().min(1).max(3).optional()
        },
        async ({ windowId, screenshotId, x, y, button, clickCount }) => result(await run((signal) =>
          service.click(windowId, screenshotId, x, y, button ?? 'left', clickCount ?? 1, signal)))
      ),
      tool(
        'windows_type_text',
        'Type literal text into the currently focused control of one window. Observe and verify focus first. If the window is blocked by a modal dialog, the text goes to the modal; the response includes targetWindowId (the window that received the input).',
        { windowId: z.string().regex(/^\d+$/), text: z.string().max(100_000) },
        async ({ windowId, text }) => result(await run((signal) => service.typeText(windowId, text, signal)))
      ),
      tool(
        'windows_press_key',
        'Press a key or + separated chord in one window, such as Return, Tab, Control+a, Shift+F10 or KP_0. If the window is blocked by a modal dialog, the key goes to the modal; the response includes targetWindowId (the window that received the input).',
        { windowId: z.string().regex(/^\d+$/), key: z.string().min(1).max(200) },
        async ({ windowId, key }) => result(await run((signal) => service.pressKey(windowId, key, signal)))
      ),
      tool(
        'windows_scroll',
        'Scroll from screenshot-relative coordinates. Positive scrollY scrolls down; negative scrollY scrolls up.',
        {
          windowId: z.string().regex(/^\d+$/), screenshotId: z.string().uuid(),
          x: z.number().min(0), y: z.number().min(0),
          scrollX: z.number().int().min(-50_000).max(50_000),
          scrollY: z.number().int().min(-50_000).max(50_000)
        },
        async ({ windowId, screenshotId, x, y, scrollX, scrollY }) => result(await run((signal) =>
          service.scroll(windowId, screenshotId, x, y, scrollX, scrollY, signal)))
      ),
      tool(
        'windows_drag',
        'Drag between two screenshot-relative points in one window.',
        {
          windowId: z.string().regex(/^\d+$/), screenshotId: z.string().uuid(),
          fromX: z.number().min(0), fromY: z.number().min(0), toX: z.number().min(0), toY: z.number().min(0)
        },
        async ({ windowId, screenshotId, fromX, fromY, toX, toY }) => result(await run((signal) =>
          service.drag(windowId, screenshotId, fromX, fromY, toX, toY, signal)))
      ),
      tool(
        'windows_set_value',
        'Replace the value of an editable elementIndex from the latest UI Automation state for this window. The index is accepted while that element is unchanged; otherwise the action is refused and you must call windows_get_state again. Can be chained without a new windows_get_state.',
        { windowId: z.string().regex(/^\d+$/), elementIndex: z.number().int().min(0).max(9_999), value: z.string().max(100_000) },
        async ({ windowId, elementIndex, value }) => result(await run((signal) => service.setValue(windowId, elementIndex, value, signal)))
      ),
      tool(
        'windows_fill',
        'Write text into a field and verify it. Tries UI Automation value, then clipboard paste (the user clipboard is restored), then keystrokes, re-reading the field after each; ok only when the final value matches. Without elementIndex it fills the focused control of the window (or its modal). mode=append keeps the current value. verified=false means the field cannot be read back — observe to confirm.',
        {
          windowId: z.string().regex(/^\d+$/),
          text: z.string().max(100_000),
          elementIndex: z.number().int().min(0).max(9_999).optional(),
          mode: z.enum(['replace', 'append']).optional()
        },
        async ({ windowId, text, elementIndex, mode }) => result(await run((signal) =>
          service.fill(windowId, text, { elementIndex, mode }, signal)))
      ),
      tool(
        'windows_secondary_action',
        'Run an accessibility action on an elementIndex from the latest UI Automation state for this window: invoke, expand, collapse, select, toggle, scroll_into_view or focus. The index is accepted while that element is unchanged; otherwise the action is refused and you must call windows_get_state again. toggle, select and focus can be chained without a new windows_get_state; invoke, expand and collapse may change the UI, so observe again afterwards.',
        {
          windowId: z.string().regex(/^\d+$/), elementIndex: z.number().int().min(0).max(9_999),
          action: z.enum(['invoke', 'expand', 'collapse', 'select', 'toggle', 'scroll_into_view', 'focus'])
        },
        async ({ windowId, elementIndex, action }) => result(await run((signal) => service.secondaryAction(windowId, elementIndex, action, signal)))
      ),
      tool(
        'windows_form_fields',
        'Read one window compactly, without a screenshot: one line per useful control as `index Type[*] "Name" (AutomationId) = "value" [options]`, a `# janela` section per window/popup/dialog and a last `ativo:` line with the active window. Indexes are reusable in windows_click_element, windows_fill, windows_set_value, windows_secondary_action and windows_run_steps target.index. Use it before windows_run_steps; if it comes back empty or useless (no accessibility, canvas), fall back to windows_get_state.',
        {
          windowId: z.string().regex(/^\d+$/),
          maxElements: z.number().int().min(1).max(1_000).optional().describe('Maximum controls listed (default 300).')
        },
        async ({ windowId, maxElements }) => result((await run((signal) => service.formFields(windowId, maxElements, signal))).text)
      ),
      tool(
        'windows_run_steps',
        'Run a whole sequence of steps in one window in a single call. Each target is resolved at run time, in the window and in popups/dialogs that open mid-sequence, so one call can go through menu, dialog, fields and confirm. Prefer target.name (case/accent-insensitive, exact before contains; add type to disambiguate) over index. Stops at the first missing or ambiguous target (with candidates) and always returns the resulting compact state: continue from it, no windows_get_state needed. Actions: fill (value), click, toggle (optional value on/off), select (value = item name), expand, focus, press (value = key or chord; only when no control does the job), wait_for (target.name to appear or target.gone to vanish). Default wait 5 s per step, 120 s per call. expect: optional text checked in the final state (expectFound).',
        {
          windowId: z.string().regex(/^\d+$/),
          steps: z.array(runStepSchema).min(1).max(500),
          expect: z.string().max(500).optional().describe('Text expected in the final state.')
        },
        async ({ windowId, steps, expect }) => {
          const { state, ...outcome } = await run((signal) => service.runSteps(windowId, steps, expect, signal))
          return result(state ? `${JSON.stringify(outcome)}\n\n${state}` : JSON.stringify(outcome))
        }
      )
    ]
  })
}
