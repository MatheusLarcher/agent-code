// @vitest-environment node

import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKMessage,
  type SDKResultMessage
} from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import type { CodexTokens } from './codexAuth'
import type { CodexResponsesRequest } from './codexProxy'
import { createWiremdMockupController } from './wiremdTools'

vi.mock('./codexAuth', () => ({
  getValidCodexTokens: vi.fn(async () => null),
  refreshCodexTokens: vi.fn(async () => null)
}))

const { startCodexProxyServer } = await import('./codexProxy')

const MODEL = 'gpt-5.6-sol'
const SECRET = 'sdk-error-integration-secret'
const tokens: CodexTokens = {
  accessToken: 'at_sdk_error_test',
  refreshToken: 'rt_sdk_error_test',
  idToken: 'id_sdk_error_test',
  accountId: 'account_sdk_error_test',
  expiresAt: Date.now() + 60_000
}

interface Capture {
  body: CodexResponsesRequest
  sessionId: string
}

function sse(events: Array<Record<string, unknown>>): Response {
  return new Response(
    events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )
}

function toolCall(responseId: string, callId: string, name: string, input: Record<string, unknown>): Response {
  const argumentsText = JSON.stringify(input)
  const item = {
    id: `fc_${callId}`,
    type: 'function_call',
    status: 'completed',
    call_id: callId,
    name,
    arguments: argumentsText
  }
  return sse([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', arguments: '' }
    },
    { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: argumentsText },
    {
      type: 'response.function_call_arguments.done',
      item_id: item.id,
      output_index: 0,
      arguments: argumentsText
    },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        output: [item],
        usage: { input_tokens: 8, output_tokens: 4 }
      }
    }
  ])
}

function text(responseId: string, value: string): Response {
  const item = {
    id: `msg_${responseId}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: value }]
  }
  return sse([
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: value },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: value },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        output: [item],
        usage: { input_tokens: 8, output_tokens: 4 }
      }
    }
  ])
}

function capture(init: RequestInit | undefined): Capture {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
  const sessionId = new Headers(init.headers).get('session_id')
  if (!sessionId) throw new Error('Expected the proxy session header')
  return { body: JSON.parse(init.body) as CodexResponsesRequest, sessionId }
}

function outputOf(body: CodexResponsesRequest, callId: string): string | undefined {
  const found = body.input.find((item) => item.type === 'function_call_output' && item.call_id === callId)
  if (found?.type !== 'function_call_output') return undefined
  return typeof found.output === 'string' ? found.output : JSON.stringify(found.output)
}

function toolNames(body: CodexResponsesRequest): string[] {
  const embedded = body.input.flatMap((item) => item.type === 'additional_tools' ? item.tools : [])
  return [...(body.tools ?? []), ...embedded].map((item) => item.name)
}

function blocks(message: SDKMessage): Array<Record<string, unknown>> {
  const content = (message as SDKMessage & { message?: { content?: unknown } }).message?.content
  return Array.isArray(content)
    ? content.filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null)
    : []
}

function resultOf(messages: SDKMessage[]): SDKResultMessage {
  const result = messages.find((message): message is SDKResultMessage => message.type === 'result')
  if (!result) throw new Error('Missing SDK result message')
  return result
}

async function run(prompt: string, options: Options): Promise<SDKMessage[]> {
  const abortController = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    abortController.abort()
  }, 25_000)
  const active = query({ prompt, options: { ...options, abortController } })
  const messages: SDKMessage[] = []
  try {
    for await (const message of active) messages.push(message)
  } finally {
    clearTimeout(timeout)
    active.close()
    // SDK 0.3.181 closes its Windows child asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (timedOut) throw new Error('Claude Agent SDK query timed out')
  return messages
}

function options(root: string, port: number, overrides: Partial<Options>): Options {
  return {
    // Query.close() in SDK 0.3.181 releases cwd asynchronously on Windows.
    // A stable temp cwd lets this test remove its own isolated temp root.
    cwd: tmpdir(),
    model: MODEL,
    executable: 'node',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_AUTH_TOKEN: SECRET,
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
      ANTHROPIC_DEFAULT_FABLE_MODEL: MODEL,
      CLAUDE_CODE_SUBAGENT_MODEL: MODEL,
      CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_TELEMETRY: '1'
    },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    settingSources: [],
    promptSuggestions: false,
    systemPrompt: 'Use the available tool exactly as requested, then continue from its result.',
    maxTurns: 4,
    ...overrides
  }
}

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `codex-proxy-${label}-`))
  await mkdir(join(root, 'claude-config'), { recursive: true })
  return root
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

describe.sequential('Codex proxy SDK tool error round-trips', () => {
  it('executes the real WireMD MCP locally and returns its result for model continuation', async () => {
    const root = await tempRoot('wiremd')
    const captured: Capture[] = []
    const final = 'WIREMD_CONTINUATION_COMPLETE'
    const source = `# Atendimento
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
    const controller = createWiremdMockupController()
    const fakeFetch: typeof fetch = async (_input, init) => {
      const request = capture(init)
      captured.push(request)
      const returned = outputOf(request.body, 'call_wiremd')
      if (returned !== undefined) return text('resp_wiremd_final', final)
      const advertised = toolNames(request.body).find((name) => name.endsWith('__render_ui_mockup'))
      if (!advertised) throw new Error('The SDK did not advertise render_ui_mockup')
      return toolCall('resp_wiremd_tool', 'call_wiremd', advertised, {
        title: 'Atendimento', source, viewport: 'desktop'
      })
    }
    const proxy = await startCodexProxyServer({
      getTokens: async () => tokens,
      refreshTokens: async () => tokens,
      secret: SECRET,
      fetchImpl: fakeFetch
    })

    try {
      const messages = await run(
        'Mostre um dashboard compacto de atendimento.',
        options(root, proxy.port, { tools: [], mcpServers: { wiremd: controller.server } })
      )
      const returned = outputOf(captured[1].body, 'call_wiremd')
      expect(returned).toContain('"type":"ui_mockup"')
      expect(returned).toContain(JSON.stringify(source).slice(1, -1))
      expect(returned).not.toContain('<!doctype html>')
      expect(
        messages.some((message) => blocks(message).some(
          (block) => block.type === 'tool_result' && block.tool_use_id === 'call_wiremd'
        ))
      ).toBe(true)
      expect(resultOf(messages)).toMatchObject({ subtype: 'success', result: final })
    } finally {
      await proxy.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 35_000)

  it('returns a canUseTool Bash denial to Codex without executing the command', async () => {
    const root = await tempRoot('deny')
    const marker = join(root, 'forbidden-marker.txt')
    const denial = 'BASH_DENIED_SENTINEL_8d20'
    const command = `node -e "require('node:fs').writeFileSync('${marker.replaceAll('\\', '/')}', 'ran')"`
    const captured: Capture[] = []
    const permission = vi.fn(async (_toolName: string, _input: Record<string, unknown>) => ({
      behavior: 'deny' as const,
      message: denial
    }))
    const fakeFetch: typeof fetch = async (_input, init) => {
      const request = capture(init)
      captured.push(request)
      return outputOf(request.body, 'call_bash_denied') === undefined
        ? toolCall('resp_bash_denied', 'call_bash_denied', 'Bash', { command })
        : text('resp_bash_final', 'BASH_DENIAL_CONTINUED')
    }
    const proxy = await startCodexProxyServer({
      getTokens: async () => tokens,
      refreshTokens: async () => tokens,
      secret: SECRET,
      fetchImpl: fakeFetch
    })

    try {
      const messages = await run(
        'Attempt the provided Bash operation.',
        options(root, proxy.port, {
          tools: ['Bash'],
          permissionMode: 'default',
          canUseTool: permission
        })
      )
      expect(permission).toHaveBeenCalledOnce()
      expect(permission.mock.calls[0][0]).toBe('Bash')
      expect(outputOf(captured[1].body, 'call_bash_denied')).toContain(denial)
      expect(outputOf(captured[1].body, 'call_bash_denied')).toMatch(/^\[tool_error\]/)
      expect(await exists(marker)).toBe(false)
      expect(resultOf(messages)).toMatchObject({ subtype: 'success', result: 'BASH_DENIAL_CONTINUED' })
    } finally {
      await proxy.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 35_000)

  it('returns an unknown-tool execution error to Codex without invoking a permission executor', async () => {
    const root = await tempRoot('unknown')
    const captured: Capture[] = []
    const permission = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }))
    const missingTool = 'DefinitelyMissingTool_2f91'
    const fakeFetch: typeof fetch = async (_input, init) => {
      const request = capture(init)
      captured.push(request)
      return outputOf(request.body, 'call_unknown') === undefined
        ? toolCall('resp_unknown', 'call_unknown', missingTool, { value: 1 })
        : text('resp_unknown_final', 'UNKNOWN_TOOL_CONTINUED')
    }
    const proxy = await startCodexProxyServer({
      getTokens: async () => tokens,
      refreshTokens: async () => tokens,
      secret: SECRET,
      fetchImpl: fakeFetch
    })

    try {
      const messages = await run(
        'Handle the tool response.',
        options(root, proxy.port, { tools: ['Read'], permissionMode: 'default', canUseTool: permission })
      )
      const returned = outputOf(captured[1].body, 'call_unknown')
      expect(permission).not.toHaveBeenCalled()
      expect(returned).toMatch(/^\[tool_error\]/)
      expect(returned).toMatch(/does not exist|unknown|not found|no such tool/i)
      expect(
        messages.some((message) =>
          blocks(message).some(
            (block) => block.type === 'tool_result' && block.tool_use_id === 'call_unknown' && block.is_error === true
          )
        )
      ).toBe(true)
      expect(resultOf(messages)).toMatchObject({ subtype: 'success', result: 'UNKNOWN_TOOL_CONTINUED' })
    } finally {
      await proxy.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 35_000)

  it("returns an in-process MCP Error('probe boom') to Codex and lets the model continue", async () => {
    const root = await tempRoot('mcp')
    const captured: Capture[] = []
    const invocation = vi.fn(async () => {
      throw new Error('probe boom')
    })
    const mcp = createSdkMcpServer({
      name: 'probe',
      version: '1.0.0',
      alwaysLoad: true,
      tools: [tool('explode', 'Throws the deterministic probe error.', {}, invocation)]
    })
    const fakeFetch: typeof fetch = async (_input, init) => {
      const request = capture(init)
      captured.push(request)
      const returned = outputOf(request.body, 'call_mcp_boom')
      if (returned !== undefined) return text('resp_mcp_final', 'MCP_ERROR_CONTINUED')
      const advertised = toolNames(request.body).find((name) => name.endsWith('__explode'))
      if (!advertised) throw new Error('The SDK did not advertise the in-process MCP tool')
      return toolCall('resp_mcp_boom', 'call_mcp_boom', advertised, {})
    }
    const proxy = await startCodexProxyServer({
      getTokens: async () => tokens,
      refreshTokens: async () => tokens,
      secret: SECRET,
      fetchImpl: fakeFetch
    })

    try {
      const messages = await run(
        'Call the probe MCP tool and continue after its error.',
        options(root, proxy.port, { tools: [], mcpServers: { probe: mcp } })
      )
      const returned = outputOf(captured[1].body, 'call_mcp_boom')
      expect(invocation).toHaveBeenCalledOnce()
      expect(returned).toMatch(/^\[tool_error\]/)
      expect(returned).toContain('probe boom')
      expect(
        messages.some((message) =>
          blocks(message).some(
            (block) => block.type === 'tool_result' && block.tool_use_id === 'call_mcp_boom' && block.is_error === true
          )
        )
      ).toBe(true)
      expect(resultOf(messages)).toMatchObject({ subtype: 'success', result: 'MCP_ERROR_CONTINUED' })
    } finally {
      await proxy.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 35_000)
})
