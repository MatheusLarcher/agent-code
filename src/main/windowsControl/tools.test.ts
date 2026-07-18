// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createWindowsControlMcpServer } from './tools'
import type { WindowsControlScope, WindowsControlService } from './service'

type RegisteredTool = { handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: unknown[] }> }

function registeredTools(): {
  tools: Record<string, RegisteredTool>
  service: Record<string, ReturnType<typeof vi.fn>>
} {
  const service = {
    listWindows: vi.fn(async () => [{ id: '1', title: 'Teste' }]),
    listApps: vi.fn(async () => []),
    launchApp: vi.fn(async () => ({ ok: true })),
    activateWindow: vi.fn(async () => ({ ok: true })),
    getWindowState: vi.fn(async () => ({
      window: { id: '1', title: 'Teste' },
      accessibility: { tree: '[0] Window', elementCount: 1 },
      screenshot: { id: crypto.randomUUID(), data: 'cG5n', mimeType: 'image/png', width: 400, height: 300 }
    })),
    clickElement: vi.fn(async () => ({ ok: true })),
    click: vi.fn(async () => ({ ok: true })),
    typeText: vi.fn(async () => ({ ok: true })),
    pressKey: vi.fn(async () => ({ ok: true })),
    scroll: vi.fn(async () => ({ ok: true })),
    drag: vi.fn(async () => ({ ok: true })),
    setValue: vi.fn(async () => ({ ok: true })),
    secondaryAction: vi.fn(async () => ({ ok: true }))
  }
  const scope = {
    run: <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => operation(new AbortController().signal),
    cancel: vi.fn()
  }
  const server = createWindowsControlMcpServer(
    scope as unknown as WindowsControlScope,
    service as unknown as WindowsControlService
  )
  const instance = server.instance as unknown as { _registeredTools: Record<string, RegisteredTool> }
  return { tools: instance._registeredTools, service }
}

describe('MCP tools de controle do Windows', () => {
  it('registra toda a superfície de observação e entrada', () => {
    const { tools } = registeredTools()
    expect(Object.keys(tools).sort()).toEqual([
      'windows_activate_window',
      'windows_click',
      'windows_click_element',
      'windows_drag',
      'windows_get_state',
      'windows_launch_app',
      'windows_list_apps',
      'windows_list_windows',
      'windows_press_key',
      'windows_scroll',
      'windows_secondary_action',
      'windows_set_value',
      'windows_type_text'
    ])
  })

  it('get_state encaminha opções e entrega texto + PNG ao modelo', async () => {
    const { tools, service } = registeredTools()
    const response = await tools.windows_get_state.handler({
      windowId: '1', includeScreenshot: true, includeText: true, maxDepth: 5, maxElements: 100
    }, {})
    expect(service.getWindowState).toHaveBeenCalledWith('1', {
      includeScreenshot: true,
      includeText: true,
      maxDepth: 5,
      maxElements: 100
    }, expect.any(AbortSignal))
    expect(response.content).toHaveLength(2)
    expect(response.content[1]).toMatchObject({ type: 'image', data: 'cG5n', mimeType: 'image/png' })
  })
})
