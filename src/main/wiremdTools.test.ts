// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { UiMockupArtifact } from '../shared/ipc'
import {
  createWiremdMockupController,
  RENDER_UI_MOCKUP_DESCRIPTION,
  type UiMockupToolController
} from './wiremdTools'
import {
  sanitizeWiremdHtml,
  UiMockupValidationError,
  validateWiremdSource,
  WireMdMockupRenderer,
  type UiMockupRenderer
} from './wiremdRenderer'

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  _meta?: Record<string, unknown>
}
type RegisteredTool = {
  description: string
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>
}

function renderTool(controller: UiMockupToolController): RegisteredTool {
  const instance = controller.server.instance as unknown as { _registeredTools: Record<string, RegisteredTool> }
  return instance._registeredTools.render_ui_mockup
}

const VALID_SOURCE = `# Atendimento
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

describe('WireMD renderer', () => {
  it('uses the real 0.6.1 programmatic API and builds one sanitized static document', async () => {
    const result = await new WireMdMockupRenderer().render(VALID_SOURCE)
    expect(result.source).toBe(VALID_SOURCE)
    expect(result.html).toMatch(/^<!doctype html><html><head>/)
    expect(result.html.match(/<iframe\b/gi)).toBeNull()
    expect(result.html.match(/<script\b/gi)).toBeNull()
    expect(result.html).toContain("default-src 'none'")
    expect(result.html).toContain('<body class="wmd-root wmd-clean">')
    expect(result.html).toContain('wmd-grid-2')
    expect(result.html).toContain('--grid-columns')
  })

  it('rejects the HTML-like syntax that caused the real three-call failure', async () => {
    const source = '# Agent-LP\n<row>\n<col>\n## Conversas\n</col>\n</row>'
    await expect(new WireMdMockupRenderer().render(source)).rejects.toMatchObject({ code: 'HTML_NOT_ALLOWED' })
  })

  it('rejects a columns container without nested column blocks instead of rendering it blank', async () => {
    const source = '# Dashboard\n::: columns-2\n## Fila\n12 chamados\n## SLA\n92%\n:::'
    await expect(new WireMdMockupRenderer().render(source)).rejects.toMatchObject({ code: 'EMPTY_COLUMNS' })
  })

  it('enforces compact column and control limits from the parsed AST', async () => {
    const fiveColumns = `# Wide
::: columns-5
${Array.from({ length: 5 }, (_, index) => `::: column\nColumn ${index + 1}\n:::`).join('\n')}
:::`
    await expect(new WireMdMockupRenderer().render(fiveColumns)).rejects.toMatchObject({
      code: 'COMPACTNESS_COLUMNS'
    })
    const controls = `# Busy form\n${Array.from({ length: 17 }, (_, index) => `[Action ${index + 1}]*`).join('\n\n')}`
    await expect(new WireMdMockupRenderer().render(controls)).rejects.toMatchObject({
      code: 'COMPACTNESS_CONTROLS'
    })
  })

  it('counts every subheading level as a visual section', async () => {
    const source = `# Busy screen
${Array.from({ length: 5 }, (_, index) => `### Section ${index + 1}\nContent`).join('\n\n')}`

    await expect(new WireMdMockupRenderer().render(source)).rejects.toMatchObject({
      code: 'COMPACTNESS_SECTIONS'
    })

    const cards = `# Compact screen
## Resumo
::: columns-4
${Array.from({ length: 4 }, (_, index) => `::: column\n### Card ${index + 1}\nValue\n:::`).join('\n')}
:::`
    await expect(new WireMdMockupRenderer().render(cards)).resolves.toMatchObject({
      html: expect.stringContaining('wmd-grid-4')
    })
  })

  it('rejects active content, React and code while accepting WireMD', () => {
    expect(() => validateWiremdSource(VALID_SOURCE)).not.toThrow()
    expect(() => validateWiremdSource('<script>alert(1)</script>')).toThrowError(UiMockupValidationError)
    expect(() => validateWiremdSource('[link](javascript:alert(1))')).toThrow(/active content/i)
    expect(() => validateWiremdSource('const Screen = () => (<main />)')).toThrow(/React and JavaScript/i)
    expect(() => validateWiremdSource('```tsx\nexport default App\n```')).toThrow(/React and JavaScript/i)
    expect(() => validateWiremdSource('')).toThrow(/required/i)
  })

  it('sanitizes renderer output with an allowlist and rejects remote CSS', () => {
    const dirty = `<!doctype html><html><head><style>.wmd-card{color:#333}</style></head><body>
      <div class="wmd-card attacker" onclick="alert(1)">Safe<script>alert(1)</script></div>
      <iframe src="https://example.com"></iframe><a href="https://example.com">Link</a>
    </body></html>`
    const clean = sanitizeWiremdHtml(dirty)
    expect(clean).toContain('Safe')
    expect(clean).toContain('class="wmd-card"')
    expect(clean).not.toMatch(/attacker|onclick|<script|<iframe|href=/i)
    expect(() => sanitizeWiremdHtml(dirty.replace('color:#333', 'background:url(https://example.com/x)')))
      .toThrow(/unsupported content/i)
  })

  it('preserves inert boolean state while removing the scripts used by tabs', async () => {
    const source = `# Tabs
::: tabs
::: tab Primeira
Conteúdo 1
:::
::: tab Segunda
Conteúdo 2
:::
:::`
    const result = await new WireMdMockupRenderer().render(source)
    expect(result.html).not.toMatch(/<script\b/i)
    expect(result.html.match(/\shidden(?:="")?>/gi)).toHaveLength(1)
  })

  it('rejects source attributes that would create an unbounded preview surface', async () => {
    await expect(new WireMdMockupRenderer().render(
      '# Form\n[Description]{rows:999999999}'
    )).rejects.toMatchObject({ code: 'UNSAFE_RENDERED_HTML' })
  })
})

describe('render_ui_mockup MCP controller', () => {
  it('registers the requested decision description and keeps HTML out of model context', async () => {
    const controller = createWiremdMockupController()
    const registered = renderTool(controller)
    expect(registered.description).toBe(RENDER_UI_MOCKUP_DESCRIPTION)
    const result = await registered.handler({ title: 'Atendimento', source: VALID_SOURCE, viewport: 'desktop' }, {})
    expect(result.isError).not.toBe(true)
    const metadata = JSON.parse(result.content[0].text)
    expect(metadata).not.toHaveProperty('html')
    expect(result._meta?.['agent-code/ui-mockup']).toMatchObject({
      type: 'ui_mockup', id: metadata.id, version: 1, title: 'Atendimento',
      source: VALID_SOURCE, viewport: 'desktop', html: expect.stringContaining("default-src 'none'")
    })
    expect(controller.takePendingArtifact(String(metadata.id), Number(metadata.version))).toMatchObject({
      type: 'ui_mockup', id: metadata.id, version: 1, title: 'Atendimento',
      source: VALID_SOURCE, viewport: 'desktop', html: expect.stringContaining("default-src 'none'")
    })
    expect(controller.seeds()[0]).toEqual({
      id: metadata.id,
      version: 1,
      title: 'Atendimento',
      source: VALID_SOURCE,
      viewport: 'desktop'
    })
    expect(controller.seeds()[0]).not.toHaveProperty('html')
  })

  it('counts invalid MCP input inside the one-retry policy instead of failing in the schema', async () => {
    const renderer: UiMockupRenderer = { render: vi.fn(async (source) => ({ html: '<p>unused</p>', source })) }
    const controller = createWiremdMockupController([], renderer)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'wiremd-test', version: '1.0.0' })
    await controller.server.instance.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const advertised = await client.listTools()
      const schema = advertised.tools.find((item) => item.name === 'render_ui_mockup')?.inputSchema as {
        required?: string[]
        properties?: Record<string, Record<string, unknown>>
      }
      // The SDK's Zod-3 bridge retains the real type/limits/enum while
      // `.catch()` lets malformed and absent values reach the handler and
      // consume the single retry instead of failing before our controller.
      expect(schema.required).toEqual(expect.arrayContaining(['title', 'source']))
      expect(schema.properties?.title).toMatchObject({
        type: 'string', minLength: 1, maxLength: 80,
        description: expect.stringContaining('80')
      })
      expect(schema.properties?.source).toMatchObject({
        type: 'string', minLength: 1, maxLength: 2_500,
        description: expect.stringContaining('2.500')
      })
      expect(schema.properties?.viewport).toMatchObject({
        type: 'string', enum: ['desktop', 'mobile'],
        default: 'desktop',
        description: expect.stringMatching(/desktop.*mobile/i)
      })
      expect(schema.properties?.title).not.toHaveProperty('default')
      expect(schema.properties?.source).not.toHaveProperty('default')
      const input = { title: 'Inválido', source: 'x'.repeat(2_501), viewport: 'desktop' }
      const first = await client.callTool({ name: 'render_ui_mockup', arguments: input })
      const second = await client.callTool({ name: 'render_ui_mockup', arguments: input })
      const third = await client.callTool({ name: 'render_ui_mockup', arguments: input })
      const payload = (value: typeof first): Record<string, unknown> => {
        const content = (value as { content?: unknown }).content
        const block = (Array.isArray(content) ? content[0] : null) as { type?: string; text?: string } | null
        return JSON.parse(block?.text ?? '{}') as Record<string, unknown>
      }
      expect(payload(first)).toMatchObject({ retryAllowed: true, code: 'INVALID_SOURCE' })
      expect(payload(second)).toMatchObject({ retryAllowed: false, message: 'Não consegui renderizar este mockup.' })
      expect(payload(third)).toEqual(payload(second))
      expect(renderer.render).not.toHaveBeenCalled()

      controller.beginTurn()
      const invalidViewport = {
        title: 'Viewport inválido', source: VALID_SOURCE, viewport: 'tablet'
      }
      const viewportFirst = await client.callTool({
        name: 'render_ui_mockup', arguments: invalidViewport
      })
      const viewportSecond = await client.callTool({
        name: 'render_ui_mockup', arguments: invalidViewport
      })
      const viewportThird = await client.callTool({
        name: 'render_ui_mockup', arguments: invalidViewport
      })
      expect(payload(viewportFirst)).toMatchObject({ retryAllowed: true, code: 'INVALID_VIEWPORT' })
      expect(payload(viewportSecond)).toMatchObject({ retryAllowed: false, message: 'Não consegui renderizar este mockup.' })
      expect(payload(viewportThird)).toEqual(payload(viewportSecond))
      expect(renderer.render).not.toHaveBeenCalled()

      controller.beginTurn()
      const missingFirst = await client.callTool({ name: 'render_ui_mockup', arguments: {} })
      const missingSecond = await client.callTool({ name: 'render_ui_mockup', arguments: {} })
      expect(payload(missingFirst)).toMatchObject({ retryAllowed: true, code: 'INVALID_TITLE' })
      expect(payload(missingSecond)).toMatchObject({ retryAllowed: false, message: 'Não consegui renderizar este mockup.' })

      controller.beginTurn()
      const valid = await client.callTool({
        name: 'render_ui_mockup',
        arguments: { title: 'MCP real', source: VALID_SOURCE }
      })
      expect(payload(valid)).toMatchObject({ ok: true, title: 'MCP real', viewport: 'desktop' })
      expect(JSON.stringify((valid as { _meta?: unknown })._meta)).toContain('agent-code/ui-mockup')
      expect(JSON.stringify((valid as { _meta?: unknown })._meta)).toContain('<p>unused</p>')
      expect(JSON.stringify((valid as { content?: unknown }).content)).not.toContain('<p>unused</p>')
    } finally {
      await client.close()
    }
  })

  it('keeps the id and increments version for the same title, including a restored seed', async () => {
    const seed = {
      id: 'saved-artifact', version: 4, title: 'Atendimento', source: VALID_SOURCE, viewport: 'desktop' as const
    }
    const renderer: UiMockupRenderer = {
      render: vi.fn(async (source) => ({ html: '<!doctype html><p>safe</p>', source }))
    }
    const controller = createWiremdMockupController([seed], renderer)
    const tool = renderTool(controller)
    const first = await tool.handler({ title: ' atendimento ', source: '# changed', viewport: 'mobile' }, {})
    const second = await tool.handler({ title: 'ATENDIMENTO', source: '# changed again', viewport: 'desktop' }, {})
    const firstMetadata = JSON.parse(first.content[0].text) as { id: string; version: number }
    const secondMetadata = JSON.parse(second.content[0].text) as { id: string; version: number }
    expect(firstMetadata).toMatchObject({ id: 'saved-artifact', version: 5 })
    expect(secondMetadata).toMatchObject({ id: 'saved-artifact', version: 6 })
    // Both versions may still be awaiting their SDK tool_result frames. Taking
    // them out of order must not let the newer revision overwrite the older.
    expect(controller.takePendingArtifact(secondMetadata.id, secondMetadata.version)?.source).toBe('# changed again')
    expect(controller.takePendingArtifact(firstMetadata.id, firstMetadata.version)?.source).toBe('# changed')
  })

  it('allows exactly one correction after a render error and resets on a new turn', async () => {
    const renderer: UiMockupRenderer = { render: vi.fn(async () => { throw new Error('bad syntax') }) }
    const controller = createWiremdMockupController([], renderer)
    const tool = renderTool(controller)
    const args = { title: 'Broken', source: '# bad', viewport: 'desktop' }
    const first = await tool.handler(args, {})
    const second = await tool.handler(args, {})
    const third = await tool.handler(args, {})
    expect(JSON.parse(first.content[0].text)).toMatchObject({ retryAllowed: true })
    expect(JSON.parse(second.content[0].text)).toMatchObject({ retryAllowed: false })
    expect(JSON.parse(third.content[0].text)).toMatchObject({ retryAllowed: false })
    expect(renderer.render).toHaveBeenCalledTimes(2)
    controller.beginTurn()
    await tool.handler(args, {})
    expect(renderer.render).toHaveBeenCalledTimes(3)
  })

  it('does not reset the single turn retry when other screens render successfully', async () => {
    const renderer: UiMockupRenderer = {
      render: vi.fn(async (source) => {
        if (source.includes('broken')) throw new Error('bad syntax')
        return { html: '<!doctype html><p>safe</p>', source }
      })
    }
    const controller = createWiremdMockupController([], renderer)
    const tool = renderTool(controller)

    const firstA = await tool.handler({ title: 'Tela A', source: '# broken', viewport: 'desktop' }, {})
    await tool.handler({ title: 'Tela B', source: '# valid B', viewport: 'desktop' }, {})
    await tool.handler({ title: 'Tela C', source: '# valid C', viewport: 'desktop' }, {})
    const secondA = await tool.handler({ title: 'Tela A', source: '# still broken', viewport: 'desktop' }, {})
    const changedTitle = await tool.handler({ title: 'Tela D', source: '# broken again', viewport: 'desktop' }, {})

    expect(JSON.parse(firstA.content[0].text)).toMatchObject({ retryAllowed: true })
    expect(JSON.parse(secondA.content[0].text)).toMatchObject({
      retryAllowed: false,
      message: 'Não consegui renderizar este mockup.'
    })
    expect(JSON.parse(changedTitle.content[0].text)).toMatchObject({
      retryAllowed: false,
      message: 'Não consegui renderizar este mockup.'
    })
    expect(renderer.render).toHaveBeenCalledTimes(4)
  })

  it('creates an independent artifact for a different title', async () => {
    const artifacts: UiMockupArtifact[] = []
    const renderer: UiMockupRenderer = {
      render: vi.fn(async (source) => ({ html: '<!doctype html><p>safe</p>', source }))
    }
    const controller = createWiremdMockupController([], renderer)
    const tool = renderTool(controller)
    for (const title of ['Dashboard', 'Login']) {
      const result = await tool.handler({ title, source: '# Screen', viewport: 'desktop' }, {})
      const metadata = JSON.parse(result.content[0].text) as { id: string; version: number }
      artifacts.push(controller.takePendingArtifact(metadata.id, metadata.version)!)
    }
    expect(artifacts[0].id).not.toBe(artifacts[1].id)
    expect(artifacts.map((artifact) => artifact.version)).toEqual([1, 1])
  })

  it('renders at most three explicitly requested screens per turn without forgetting older titles', async () => {
    const renderer: UiMockupRenderer = {
      render: vi.fn(async (source) => ({ html: '<!doctype html><p>safe</p>', source }))
    }
    const controller = createWiremdMockupController([], renderer)
    const tool = renderTool(controller)
    const results: ToolResult[] = []
    for (const title of ['Login', 'Dashboard', 'Clientes', 'Configurações']) {
      results.push(await tool.handler({ title, source: `# ${title}`, viewport: 'desktop' }, {}))
    }
    expect(results.slice(0, 3).every((result) => result.isError !== true)).toBe(true)
    expect(JSON.parse(results[3].content[0].text)).toMatchObject({
      retryAllowed: false,
      code: 'TOO_MANY_SCREENS'
    })
    expect(renderer.render).toHaveBeenCalledTimes(3)
    expect(controller.seeds()).toHaveLength(3)

    controller.beginTurn()
    const fourth = await tool.handler({ title: 'Configurações', source: '# Configurações', viewport: 'desktop' }, {})
    expect(fourth.isError).not.toBe(true)
    expect(controller.seeds().map((seed) => seed.title)).toEqual([
      'Configurações', 'Clientes', 'Dashboard', 'Login'
    ])

    controller.beginTurn()
    const firstMetadata = JSON.parse(results[0].content[0].text) as { id: string; version: number }
    const revised = await tool.handler({ title: 'Login', source: '# Login revisado', viewport: 'mobile' }, {})
    expect(JSON.parse(revised.content[0].text)).toMatchObject({
      id: firstMetadata.id,
      version: firstMetadata.version + 1
    })
  })

  it('rejects a version that cannot be incremented without producing an unsafe artifact', async () => {
    const renderer: UiMockupRenderer = {
      render: vi.fn(async (source) => ({ html: '<!doctype html><p>safe</p>', source }))
    }
    const controller = createWiremdMockupController([{
      id: 'max-version',
      version: Number.MAX_SAFE_INTEGER,
      title: 'Limite',
      source: '# Limite',
      viewport: 'desktop'
    }], renderer)
    const result = await renderTool(controller).handler({
      title: 'Limite', source: '# Alterado', viewport: 'desktop'
    }, {})

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      retryAllowed: true,
      code: 'VERSION_EXHAUSTED'
    })
    expect(renderer.render).not.toHaveBeenCalled()
  })

  it('serializes concurrent MCP renders so the three-screen cap remains atomic', async () => {
    const renderer: UiMockupRenderer = {
      render: vi.fn(async (source) => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { html: '<!doctype html><p>safe</p>', source }
      })
    }
    const controller = createWiremdMockupController([], renderer)
    const tool = renderTool(controller)
    const results = await Promise.all(['A', 'B', 'C', 'D'].map((title) =>
      tool.handler({ title, source: `# ${title}`, viewport: 'desktop' }, {})
    ))
    const payloads = results.map((result) => JSON.parse(result.content[0].text) as { ok?: boolean; code?: string })

    expect(payloads.filter((payload) => payload.ok === true)).toHaveLength(3)
    expect(payloads.filter((payload) => payload.code === 'TOO_MANY_SCREENS')).toHaveLength(1)
    expect(renderer.render).toHaveBeenCalledTimes(3)
    expect(controller.seeds()).toHaveLength(3)
  })

  it('serializes concurrent revisions of one title onto one id with increasing versions', async () => {
    const renderer: UiMockupRenderer = {
      render: vi.fn(async (source) => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { html: '<!doctype html><p>safe</p>', source }
      })
    }
    const controller = createWiremdMockupController([], renderer)
    const tool = renderTool(controller)
    const results = await Promise.all(['# Primeira', '# Segunda'].map((source) =>
      tool.handler({ title: 'Mesmo título', source, viewport: 'desktop' }, {})
    ))
    const payloads = results.map((result) => JSON.parse(result.content[0].text) as { id: string; version: number })

    expect(payloads[0].id).toBe(payloads[1].id)
    expect(payloads.map((payload) => payload.version)).toEqual([1, 2])
    expect(controller.seeds()).toEqual([expect.objectContaining({
      id: payloads[0].id, version: 2, source: '# Segunda'
    })])
  })
})
