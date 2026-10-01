// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createWindowsControlMcpServer, WINDOWS_CONTROL_HINT } from './tools'
import type { WindowsControlScope, WindowsControlService } from './service'

type RegisteredTool = {
  description?: string
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: unknown[] }>
}

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
    fill: vi.fn(async () => ({ ok: true, method: 'value', verified: true, targetWindowId: '1' })),
    secondaryAction: vi.fn(async () => ({ ok: true })),
    formFields: vi.fn(async () => ({
      text: '# janela "Sem título - Bloco de Notas"\n0 Edit* "Editor de texto" = ""\nativo: "Sem título - Bloco de Notas" (windowId 1)',
      count: 1,
      targetWindowId: '1'
    })),
    runSteps: vi.fn(async () => ({
      ok: true, done: 2, total: 2, expectFound: true, targetWindowId: '1',
      state: '0 Edit* "Editor de texto" = "oi"\nativo: "Bloco de Notas" (windowId 1)'
    }))
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
      'windows_fill',
      'windows_form_fields',
      'windows_get_state',
      'windows_launch_app',
      'windows_list_apps',
      'windows_list_windows',
      'windows_press_key',
      'windows_run_steps',
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

  it('hint permite encadear ações seguras e manda seguir o targetWindowId', () => {
    expect(WINDOWS_CONTROL_HINT).not.toContain('Execute uma ação por vez')
    expect(WINDOWS_CONTROL_HINT).not.toContain('Verifique o foco antes de windows_type_text')
    expect(WINDOWS_CONTROL_HINT).toMatch(/windows_set_value[^\n]*podem ser encadeadas sem novo windows_get_state/)
    expect(WINDOWS_CONTROL_HINT).toContain('targetWindowId')
    expect(WINDOWS_CONTROL_HINT).toMatch(/Observe de novo depois de clique em botão/)
  })

  it('descrições de type_text e press_key citam o redirecionamento ao modal', () => {
    const { tools } = registeredTools()
    for (const name of ['windows_type_text', 'windows_press_key']) {
      expect(tools[name].description).toMatch(/modal/)
      expect(tools[name].description).toContain('targetWindowId')
    }
    expect(tools.windows_get_state.description).not.toContain('Observe again after acting.')
    expect(tools.windows_click_element.description).toMatch(/unchanged/)
  })

  it('descrições de set_value e secondary_action explicam validade do índice e encadeamento', () => {
    const { tools } = registeredTools()
    for (const name of ['windows_set_value', 'windows_secondary_action']) {
      expect(tools[name].description).toMatch(/unchanged/)
      expect(tools[name].description).toContain('windows_get_state again')
    }
    expect(tools.windows_set_value.description).toMatch(/chained without a new windows_get_state/)
    expect(tools.windows_secondary_action.description).toMatch(/toggle[^.]*select[^.]*focus[^.;]*chained/)
    expect(tools.windows_secondary_action.description).toMatch(/invoke[^.]*expand[^.]*collapse[^.]*observe again/)
  })

  it('windows_fill encaminha elementIndex/mode e valida a entrada com zod', async () => {
    const { tools, service } = registeredTools()
    await tools.windows_fill.handler({ windowId: '1', text: 'teste de velocidade', elementIndex: 3, mode: 'append' }, {})
    expect(service.fill).toHaveBeenCalledWith('1', 'teste de velocidade', { elementIndex: 3, mode: 'append' }, expect.any(AbortSignal))
    await tools.windows_fill.handler({ windowId: '1', text: 'x' }, {})
    expect(service.fill).toHaveBeenLastCalledWith('1', 'x', { elementIndex: undefined, mode: undefined }, expect.any(AbortSignal))

    const shape = (tools.windows_fill as unknown as { inputSchema: z.ZodTypeAny }).inputSchema
    expect(shape.safeParse({ windowId: '1', text: 'a'.repeat(100_001) }).success).toBe(false)
    expect(shape.safeParse({ windowId: '1', text: 'a', mode: 'insert' }).success).toBe(false)
    expect(shape.safeParse({ windowId: '1', text: 'a', elementIndex: -1 }).success).toBe(false)
    expect(shape.safeParse({ windowId: 'abc', text: 'a' }).success).toBe(false)
    expect(shape.safeParse({ windowId: '1', text: '' }).success).toBe(true)
  })

  it('hint manda usar windows_fill para texto e type_text/press_key só para teclas', () => {
    expect(WINDOWS_CONTROL_HINT).toMatch(/texto[^\n]*windows_fill/)
    expect(WINDOWS_CONTROL_HINT).toMatch(/windows_type_text e windows_press_key só para atalhos e teclas especiais/)
    const { tools } = registeredTools()
    expect(tools.windows_fill.description).toMatch(/verif/)
  })

  it('windows_form_fields repassa ao service e devolve o texto compacto puro', async () => {
    const { tools, service } = registeredTools()
    const response = await tools.windows_form_fields.handler({ windowId: '1', maxElements: 50 }, {})
    expect(service.formFields).toHaveBeenCalledWith('1', 50, expect.any(AbortSignal))
    expect(response.content).toEqual([{
      type: 'text',
      text: '# janela "Sem título - Bloco de Notas"\n0 Edit* "Editor de texto" = ""\nativo: "Sem título - Bloco de Notas" (windowId 1)'
    }])
    const shape = (tools.windows_form_fields as unknown as { inputSchema: z.ZodTypeAny }).inputSchema
    expect(shape.safeParse({ windowId: '1' }).success).toBe(true)
    expect(shape.safeParse({ windowId: '1', maxElements: 1_001 }).success).toBe(false)
    expect(shape.safeParse({ windowId: 'x' }).success).toBe(false)
  })

  it('windows_run_steps repassa passos/expect e devolve JSON compacto + state', async () => {
    const { tools, service } = registeredTools()
    const steps = [
      { action: 'fill', target: { name: 'Editor de texto' }, value: 'oi' },
      { action: 'click', target: { name: 'Salvar', type: 'Button' } }
    ]
    const response = await tools.windows_run_steps.handler({ windowId: '1', steps, expect: 'oi' }, {})
    expect(service.runSteps).toHaveBeenCalledWith('1', steps, 'oi', expect.any(AbortSignal))
    const text = (response.content[0] as { text: string }).text
    expect(text).toBe(
      '{"ok":true,"done":2,"total":2,"expectFound":true,"targetWindowId":"1"}\n\n' +
      '0 Edit* "Editor de texto" = "oi"\nativo: "Bloco de Notas" (windowId 1)'
    )
  })

  it('schema de windows_run_steps aceita passos válidos e recusa os malformados', () => {
    const { tools } = registeredTools()
    const shape = (tools.windows_run_steps as unknown as { inputSchema: z.ZodTypeAny }).inputSchema
    const ok = (steps: unknown[], extra: Record<string, unknown> = {}): boolean =>
      shape.safeParse({ windowId: '1', steps, ...extra }).success
    expect(ok([
      { action: 'fill', target: { index: 0 }, value: '' },
      { action: 'click', target: { name: 'Arquivo' } },
      { action: 'click', target: { automationId: 'SaveButton' }, timeoutMs: 10_000 },
      { action: 'toggle', target: { name: 'Quebra automática' }, value: 'on' },
      { action: 'toggle', target: { name: 'Negrito' } },
      { action: 'select', target: { name: 'Tipo' }, value: 'Texto (*.txt)' },
      { action: 'expand', target: { name: 'Pastas' } },
      { action: 'focus', target: { name: 'Nome' } },
      { action: 'press', value: 'Return' },
      { action: 'wait_for', target: { name: 'Salvar como' } },
      { action: 'wait_for', target: { gone: 'Salvar como' } }
    ], { expect: 'nota.txt' })).toBe(true)

    expect(ok([])).toBe(false)
    expect(ok(Array.from({ length: 501 }, () => ({ action: 'press', value: 'Tab' })))).toBe(false)
    expect(ok([{ action: 'double_click', target: { name: 'x' } }])).toBe(false)
    expect(ok([{ action: 'fill', target: { name: 'Nome' } }])).toBe(false)
    expect(ok([{ action: 'click' }])).toBe(false)
    expect(ok([{ action: 'click', target: { type: 'Button' } }])).toBe(false)
    expect(ok([{ action: 'select', target: { name: 'Tipo' } }])).toBe(false)
    expect(ok([{ action: 'press' }])).toBe(false)
    expect(ok([{ action: 'press', value: '' }])).toBe(false)
    expect(ok([{ action: 'wait_for' }])).toBe(false)
    expect(ok([{ action: 'wait_for', target: { index: 3 } }])).toBe(false)
    expect(ok([{ action: 'toggle', target: { name: 'x' }, value: 'sim' }])).toBe(false)
    expect(ok([{ action: 'click', target: { name: 'x' }, timeoutMs: 50 }])).toBe(false)
    expect(ok([{ action: 'click', target: { name: 'x'.repeat(501) } }])).toBe(false)
    expect(ok([{ action: 'click', target: { index: 10_000 } }])).toBe(false)
    expect(ok([{ action: 'press', value: 'Tab' }], { expect: 'x'.repeat(501) })).toBe(false)

    // O SDK publica o schema como JSON Schema em tools/list: o refinamento não pode quebrar isso.
    const json = z.toJSONSchema(shape) as unknown as { properties: { steps: { items: { properties: Record<string, unknown> } } } }
    expect(Object.keys(json.properties.steps.items.properties).sort()).toEqual(['action', 'target', 'timeoutMs', 'value'])
  })

  it('hint põe comando antes da interface, form_fields → run_steps e screenshot como alternativa', () => {
    for (const text of ['ms-settings', 'winget', 'PowerShell', 'windows_form_fields', 'windows_run_steps', 'targetWindowId'])
      expect(WINDOWS_CONTROL_HINT).toContain(text)
    expect(WINDOWS_CONTROL_HINT).toMatch(/windows_form_fields → UM windows_run_steps[^\n]*alvo por nome/)
    expect(WINDOWS_CONTROL_HINT).toMatch(/Alternativa: windows_get_state com screenshot[^\n]*vier vazio/)
    expect(WINDOWS_CONTROL_HINT).toMatch(/Não use atalhos de teclado como caminho principal/)
    expect(WINDOWS_CONTROL_HINT).toContain('Nunca invente windowId')
    expect(WINDOWS_CONTROL_HINT).toMatch(/ativada em Configurações; não tente contornar/)
  })
})
