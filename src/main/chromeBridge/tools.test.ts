// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createChromeMcpServer, type ChromeCaller, type ChromeTabMemory } from './tools'
import { ERR_NOT_CONNECTED } from './protocol'

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<Record<string, unknown>>; isError?: boolean }>

/** Pega o handler registrado no McpServer do SDK (mesma estrutura usada pelos outros testes de tools). */
function handlers(server: ReturnType<typeof createChromeMcpServer>): Record<string, Handler> {
  const registered = (server.instance as unknown as { _registeredTools: Record<string, { handler?: Handler; callback?: Handler }> })._registeredTools
  return Object.fromEntries(Object.entries(registered).map(([name, t]) => [name, (t.handler ?? t.callback) as Handler]))
}

function setup(result: unknown = { tabId: 7, url: 'https://x', title: 'X' }) {
  const call = vi.fn(async () => result)
  const bridge: ChromeCaller = { call }
  const memory: ChromeTabMemory = {}
  const tools = handlers(createChromeMcpServer(() => bridge, memory))
  return { call, memory, tools }
}

describe('ferramentas chrome', () => {
  it('registra as 15 ferramentas da spec', () => {
    expect(Object.keys(setup().tools).sort()).toEqual(
      [
        'chrome_click', 'chrome_close_tab', 'chrome_evaluate', 'chrome_list_tabs', 'chrome_navigate', 'chrome_open_tab',
        'chrome_press_key', 'chrome_screenshot', 'chrome_scroll', 'chrome_select_option', 'chrome_select_tab',
        'chrome_snapshot', 'chrome_status', 'chrome_type', 'chrome_wait'
      ].sort()
    )
  })

  it('mapeia ferramenta → método/params e sem tabId usa a última aba', async () => {
    const { call, memory, tools } = setup()
    await tools.chrome_click({ ref: 'e3' }, {})
    expect(call).toHaveBeenLastCalledWith('click', { ref: 'e3' })
    expect(memory.lastTabId).toBe(7)
    await tools.chrome_type({ ref: 'e4', text: 'oi', submit: true }, {})
    expect(call).toHaveBeenLastCalledWith('type', { ref: 'e4', text: 'oi', submit: true, tabId: 7 })
    await tools.chrome_press_key({ tabId: 9, key: 'Enter' }, {})
    expect(call).toHaveBeenLastCalledWith('pressKey', { tabId: 9, key: 'Enter' })
    await tools.chrome_list_tabs({}, {})
    expect(call).toHaveBeenLastCalledWith('listTabs', {})
    await tools.chrome_open_tab({ url: 'https://a.b' }, {})
    expect(call).toHaveBeenLastCalledWith('openTab', { url: 'https://a.b' })
    await tools.chrome_select_option({ ref: 'e1', value: 'v' }, {})
    expect(call).toHaveBeenLastCalledWith('selectOption', { ref: 'e1', value: 'v', tabId: 7 })
  })

  it('fechar a última aba esquece o padrão', async () => {
    const { memory, tools } = setup({ ok: true })
    memory.lastTabId = 7
    await tools.chrome_close_tab({ tabId: 7 }, {})
    expect(memory.lastTabId).toBeUndefined()
  })

  it('screenshot volta como imagem MCP JPEG', async () => {
    const { tools } = setup({ data: 'QUJD', tabId: 2, url: 'u', title: 't' })
    const res = await tools.chrome_screenshot({}, {})
    expect(res.content[0]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' })
    expect(JSON.parse(res.content[1].text as string)).toEqual({ tabId: 2, url: 'u', title: 't' })
  })

  it('sem ponte ou com erro devolve isError com a mensagem', async () => {
    const tools = handlers(createChromeMcpServer(() => null))
    const res = await tools.chrome_status({}, {})
    expect(res).toMatchObject({ isError: true, content: [{ type: 'text', text: ERR_NOT_CONNECTED }] })
    const failing = handlers(createChromeMcpServer(() => ({ call: async () => { throw new Error('Ref expirada — faça um novo chrome_snapshot') } })))
    expect((await failing.chrome_click({ ref: 'e1' }, {})).content[0].text).toContain('Ref expirada')
  })
})
