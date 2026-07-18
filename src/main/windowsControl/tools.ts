import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { windowsControl, type WindowsControlScope, type WindowsControlService } from './service'

type ToolResult = { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }

const result = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
})

export const WINDOWS_CONTROL_HINT = `## Controle de aplicativos do Windows
Você possui ferramentas windows_* para controlar aplicativos desktop quando o usuário habilita “Permitir controle do Windows”.
- Use-as somente para interação real com aplicativos Windows; para editar código ou rodar comandos, prefira as ferramentas normais.
- Comece com windows_list_apps ou windows_list_windows. Nunca invente windowId.
- Antes de clicar por coordenadas, chame windows_get_state e use o screenshotId retornado. Coordenadas e screenshotId expiram após mudanças.
- Para acessibilidade, use somente elementIndex da árvore mais recente. Observe novamente após qualquer ação que possa alterar a interface.
- Verifique o foco antes de windows_type_text. Execute uma ação por vez e capture o estado novamente para confirmar o resultado.
- Se a permissão estiver desligada, explique que ela deve ser ativada em Configurações; não tente contornar o bloqueio.`

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
        'Observe one exact window. Returns a screenshot id for coordinate actions and/or a UI Automation tree with element indexes. Observe again after acting.',
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
        'Invoke or click one elementIndex from the latest UI Automation state for this window.',
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
        'Type literal text into the currently focused control of one window. Observe and verify focus first.',
        { windowId: z.string().regex(/^\d+$/), text: z.string().max(100_000) },
        async ({ windowId, text }) => result(await run((signal) => service.typeText(windowId, text, signal)))
      ),
      tool(
        'windows_press_key',
        'Press a key or + separated chord in one window, such as Return, Tab, Control+a, Shift+F10 or KP_0.',
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
        'Replace the value of an editable elementIndex from the latest UI Automation state.',
        { windowId: z.string().regex(/^\d+$/), elementIndex: z.number().int().min(0).max(9_999), value: z.string().max(100_000) },
        async ({ windowId, elementIndex, value }) => result(await run((signal) => service.setValue(windowId, elementIndex, value, signal)))
      ),
      tool(
        'windows_secondary_action',
        'Run an accessibility action on an element: invoke, expand, collapse, select, toggle, scroll_into_view or focus.',
        {
          windowId: z.string().regex(/^\d+$/), elementIndex: z.number().int().min(0).max(9_999),
          action: z.enum(['invoke', 'expand', 'collapse', 'select', 'toggle', 'scroll_into_view', 'focus'])
        },
        async ({ windowId, elementIndex, action }) => result(await run((signal) => service.secondaryAction(windowId, elementIndex, action, signal)))
      )
    ]
  })
}
