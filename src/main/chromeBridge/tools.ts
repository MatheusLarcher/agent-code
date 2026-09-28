import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { ERR_NOT_CONNECTED } from './protocol'

/** O mínimo que as ferramentas usam da ChromeBridge (facilita teste). */
export interface ChromeCaller {
  call(method: string, params?: unknown): Promise<unknown>
}

/** Última aba usada por conversa — é o tabId padrão quando o modelo omite. */
export interface ChromeTabMemory {
  lastTabId?: number
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
type ToolResult = { content: Content[]; isError?: boolean }

const text = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
})

const tabId = z.number().int().nonnegative().optional().describe('Aba alvo. Padrão: a última usada nesta conversa.')
const ref = z.string().regex(/^e\d+$/).describe('Ref [eN] do chrome_snapshot mais recente.')

export function createChromeMcpServer(
  getBridge: () => ChromeCaller | null,
  memory: ChromeTabMemory = {}
): ReturnType<typeof createSdkMcpServer> {
  const invoke = async (method: string, params: Record<string, unknown>, tabScoped: boolean): Promise<unknown> => {
    const bridge = getBridge()
    if (!bridge) throw new Error(ERR_NOT_CONNECTED)
    const withTab =
      tabScoped && params.tabId === undefined && memory.lastTabId !== undefined
        ? { ...params, tabId: memory.lastTabId }
        : params
    const res = await bridge.call(method, stripUndefined(withTab))
    const got = (res as { tabId?: unknown } | null)?.tabId
    if (typeof got === 'number') memory.lastTabId = got
    return res
  }
  const run = (method: string, tabScoped = true) => async (params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      return text(await invoke(method, params, tabScoped))
    } catch (err) {
      return { ...text(err instanceof Error ? err.message : String(err)), isError: true }
    }
  }

  return createSdkMcpServer({
    name: 'chrome',
    version: '1.0.0',
    tools: [
      tool('chrome_status', 'Estado da extensão do Chrome do usuário (conectada, pausada, navegador).', {}, run('status', false)),
      tool('chrome_list_tabs', 'Lista as abas abertas no Chrome do usuário (tabId, url, título, aba ativa).', {}, run('listTabs', false)),
      tool(
        'chrome_snapshot',
        'Lê a página: elementos interativos como [eN] role "nome" e o texto visível. Use as refs em click/type.',
        { tabId, maxChars: z.number().int().min(500).max(50_000).optional() },
        run('snapshot')
      ),
      tool('chrome_screenshot', 'Captura a aba visível como imagem JPEG.', { tabId }, async (params) => {
        try {
          const res = (await invoke('screenshot', params, true)) as { data?: unknown; tabId?: unknown; url?: unknown; title?: unknown }
          if (typeof res?.data !== 'string') throw new Error('Screenshot sem imagem')
          const { data, ...meta } = res
          return { content: [{ type: 'image', data, mimeType: 'image/jpeg' }, { type: 'text', text: JSON.stringify(meta) }] }
        } catch (err) {
          return { ...text(err instanceof Error ? err.message : String(err)), isError: true }
        }
      }),
      tool(
        'chrome_scroll',
        'Rola a página (direction/amount) ou até um elemento (ref).',
        { tabId, direction: z.enum(['up', 'down']).optional(), amount: z.number().int().min(1).max(20_000).optional(), ref: ref.optional() },
        run('scroll')
      ),
      tool(
        'chrome_wait',
        'Espera um texto aparecer na página ou um tempo fixo (máx. 25 s).',
        { tabId, text: z.string().min(1).max(500).optional(), ms: z.number().int().min(0).max(25_000).optional() },
        run('wait')
      ),
      tool('chrome_open_tab', 'Abre uma nova aba (grupo "Agent Code") na URL.', { url: z.string().url() }, run('openTab', false)),
      tool('chrome_select_tab', 'Ativa uma aba pelo tabId.', { tabId: z.number().int().nonnegative() }, run('selectTab', false)),
      tool('chrome_close_tab', 'Fecha uma aba pelo tabId.', { tabId: z.number().int().nonnegative() }, async (params) => {
        const res = await run('closeTab', false)(params)
        if (!res.isError && memory.lastTabId === params.tabId) memory.lastTabId = undefined
        return res
      }),
      tool(
        'chrome_navigate',
        'Navega a aba para uma URL, ou volta/avança/recarrega.',
        { tabId, url: z.string().url().optional(), action: z.enum(['back', 'forward', 'reload']).optional() },
        run('navigate')
      ),
      tool(
        'chrome_click',
        'Clica num elemento (ref) ou em coordenadas x,y da viewport.',
        { tabId, ref: ref.optional(), x: z.number().min(0).optional(), y: z.number().min(0).optional() },
        run('click')
      ),
      tool(
        'chrome_type',
        'Digita texto no elemento (ref) ou no foco atual. clear apaga antes; submit pressiona Enter depois.',
        { tabId, ref: ref.optional(), text: z.string().max(20_000), clear: z.boolean().optional(), submit: z.boolean().optional() },
        run('type')
      ),
      tool(
        'chrome_press_key',
        'Pressiona uma tecla ou combinação (ex.: Enter, Escape, Control+a).',
        { tabId, key: z.string().min(1).max(50) },
        run('pressKey')
      ),
      tool('chrome_select_option', 'Escolhe uma opção de um <select> (ref) pelo value.', { tabId, ref, value: z.string().max(2_000) }, run('selectOption')),
      tool(
        'chrome_evaluate',
        'Executa JavaScript na página e devolve o resultado (JSON, até 8000 caracteres).',
        { tabId, expression: z.string().min(1).max(50_000) },
        run('evaluate')
      )
    ]
  })
}

function stripUndefined(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))
}
