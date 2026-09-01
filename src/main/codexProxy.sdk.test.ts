// @vitest-environment node

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query, type Options, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import type { CodexTokens } from './codexAuth'
import type { CodexResponsesRequest } from './codexProxy'

vi.mock('./codexAuth', () => ({
  getValidCodexTokens: vi.fn(async () => null),
  refreshCodexTokens: vi.fn(async () => null)
}))

const { startCodexProxyServer } = await import('./codexProxy')

const MODEL = 'gpt-5.6-sol'
const SECRET = 'sdk-integration-secret'
const QUERY_TIMEOUT_MS = 25_000

const tokens: CodexTokens = {
  accessToken: 'at_sdk_test',
  refreshToken: 'rt_sdk_test',
  idToken: 'id_sdk_test',
  accountId: 'account_sdk_test',
  expiresAt: Date.now() + 60_000
}

interface CapturedRequest {
  body: CodexResponsesRequest
  sessionId: string
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  })
}

function functionCallResponse(
  responseId: string,
  callId: string,
  name: string,
  input: Record<string, unknown>,
  reasoning?: Record<string, unknown>
): Response {
  const argumentsText = JSON.stringify(input)
  const call = {
    id: `fc_${callId}`,
    type: 'function_call',
    status: 'completed',
    call_id: callId,
    name,
    arguments: argumentsText
  }
  const output = [...(reasoning ? [reasoning] : []), call]
  return sseResponse([
    ...(reasoning
      ? [{ type: 'response.output_item.done', output_index: 0, item: reasoning }]
      : []),
    {
      type: 'response.output_item.added',
      output_index: reasoning ? 1 : 0,
      item: { ...call, status: 'in_progress', arguments: '' }
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: call.id,
      output_index: reasoning ? 1 : 0,
      delta: argumentsText
    },
    {
      type: 'response.function_call_arguments.done',
      item_id: call.id,
      output_index: reasoning ? 1 : 0,
      arguments: argumentsText
    },
    {
      type: 'response.output_item.done',
      output_index: reasoning ? 1 : 0,
      item: call
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        output,
        usage: { input_tokens: 10, output_tokens: 5 }
      }
    }
  ])
}

function textResponse(responseId: string, text: string): Response {
  const item = {
    id: `msg_${responseId}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text }]
  }
  return sseResponse([
    {
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text
    },
    {
      type: 'response.output_text.done',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text
    },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        status: 'completed',
        output: [item],
        usage: { input_tokens: 10, output_tokens: 5 }
      }
    }
  ])
}

function captureRequest(init: RequestInit | undefined): CapturedRequest {
  if (typeof init?.body !== 'string') throw new Error('Expected the proxy to send a JSON request body')
  const sessionId = new Headers(init.headers).get('session_id')
  if (!sessionId) throw new Error('Expected a session_id header')
  return { body: JSON.parse(init.body) as CodexResponsesRequest, sessionId }
}

function toolNames(body: CodexResponsesRequest): string[] {
  const topLevel = (body.tools ?? []).map((tool) => tool.name)
  const litePrefix = body.input.flatMap((item) =>
    item.type === 'additional_tools' ? item.tools.map((tool) => tool.name) : []
  )
  return [...topLevel, ...litePrefix]
}

function developerText(body: CodexResponsesRequest): string {
  return body.input
    .flatMap((item) =>
      item.type === 'message' && item.role === 'developer'
        ? item.content.flatMap((part) => (part.type === 'input_text' ? [part.text] : []))
        : []
    )
    .join('\n')
}

function functionOutput(body: CodexResponsesRequest, callId: string): string | undefined {
  const item = body.input.find(
    (candidate) => candidate.type === 'function_call_output' && candidate.call_id === callId
  )
  if (item?.type !== 'function_call_output') return undefined
  return typeof item.output === 'string' ? item.output : JSON.stringify(item.output)
}

function contentBlocks(message: SDKMessage): Array<Record<string, unknown>> {
  const candidate = message as SDKMessage & { message?: { content?: unknown } }
  return Array.isArray(candidate.message?.content)
    ? candidate.message.content.filter(
        (block): block is Record<string, unknown> => typeof block === 'object' && block !== null
      )
    : []
}

function resultMessage(messages: SDKMessage[]): SDKResultMessage {
  const result = messages.find((message): message is SDKResultMessage => message.type === 'result')
  if (!result) throw new Error('Claude Agent SDK did not emit a result message')
  return result
}

async function collectQuery(prompt: string, options: Options): Promise<SDKMessage[]> {
  const abortController = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    abortController.abort()
  }, QUERY_TIMEOUT_MS)
  const running = query({ prompt, options: { ...options, abortController } })
  const messages: SDKMessage[] = []
  try {
    for await (const message of running) messages.push(message)
  } finally {
    clearTimeout(timeout)
    running.close()
    // SDK 0.3.181 returns from close() before the Windows child releases cwd.
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (timedOut) throw new Error(`Claude Agent SDK query exceeded ${QUERY_TIMEOUT_MS}ms`)
  return messages
}

function sdkOptions(
  root: string,
  port: number,
  overrides: Partial<Options>
): Options {
  return {
    // Keep the Windows child cwd on the stable OS temp directory; every
    // fixture/config artifact still lives under this test's mkdtemp root.
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
    systemPrompt: 'Follow the user request and use only the explicitly available tools.',
    ...overrides
  }
}

async function makeTempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `codex-proxy-${label}-`))
  await mkdir(join(root, 'claude-config'), { recursive: true })
  return root
}

describe.sequential('Codex proxy with the real Claude Agent SDK/CLI', () => {
  it('executes Read and restores reasoning/function state before function_call_output', async () => {
    const root = await makeTempRoot('read')
    const fixturePath = join(root, 'probe.txt')
    const fileSentinel = 'REAL_READ_TOOL_SENTINEL_7e62'
    const finalSentinel = 'READ_CONTINUATION_COMPLETE_41b9'
    const persistentContextSentinel =
      'AUTHORITATIVE FILESYSTEM SKILLS CATALOG\n- /sdk-probe\n  Description: full skill description on every request\n' +
      'AUTHORITATIVE PERSISTENT MEMORY CATALOG\n--- MEMORY FILE: probe.md ---\nfull memory on every request'
    const reasoning = {
      id: 'rs_read_roundtrip',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Need the requested file.' }],
      encrypted_content: 'encrypted_read_roundtrip'
    }
    await writeFile(fixturePath, fileSentinel, 'utf8')

    const captured: CapturedRequest[] = []
    const fakeFetch: typeof fetch = async (_input, init) => {
      const request = captureRequest(init)
      captured.push(request)
      if (functionOutput(request.body, 'call_read_roundtrip') !== undefined) {
        return textResponse('resp_read_final', finalSentinel)
      }
      return functionCallResponse(
        'resp_read_tool',
        'call_read_roundtrip',
        'Read',
        { file_path: fixturePath },
        reasoning
      )
    }
    const server = await startCodexProxyServer({
      getTokens: async () => tokens,
      refreshTokens: async () => tokens,
      secret: SECRET,
      fetchImpl: fakeFetch
    })

    try {
      const messages = await collectQuery(
        'Read probe.txt exactly once, then report completion.',
        sdkOptions(root, server.port, { tools: ['Read'], maxTurns: 4, systemPrompt: persistentContextSentinel })
      )

      expect(captured).toHaveLength(2)
      expect(toolNames(captured[0].body)).toContain('Read')
      expect(captured.every((request) => developerText(request.body).includes(persistentContextSentinel))).toBe(true)
      expect(new Set(captured.map((request) => request.sessionId)).size).toBe(1)

      const continuation = captured[1].body.input
      const reasoningIndex = continuation.findIndex(
        (item) => item.type === 'reasoning' && item.id === reasoning.id
      )
      const callIndex = continuation.findIndex(
        (item) => item.type === 'function_call' && item.call_id === 'call_read_roundtrip'
      )
      const outputIndex = continuation.findIndex(
        (item) => item.type === 'function_call_output' && item.call_id === 'call_read_roundtrip'
      )
      expect(reasoningIndex).toBeGreaterThanOrEqual(0)
      expect(callIndex).toBeGreaterThan(reasoningIndex)
      expect(outputIndex).toBeGreaterThan(callIndex)
      expect(continuation[reasoningIndex]).toEqual(reasoning)
      expect(continuation[callIndex]).toMatchObject({
        id: 'fc_call_read_roundtrip',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_read_roundtrip',
        name: 'Read',
        arguments: JSON.stringify({ file_path: fixturePath })
      })
      expect(functionOutput(captured[1].body, 'call_read_roundtrip')).toContain(fileSentinel)

      expect(
        messages.some((message) =>
          contentBlocks(message).some(
            (block) => block.type === 'tool_use' && block.id === 'call_read_roundtrip' && block.name === 'Read'
          )
        )
      ).toBe(true)
      expect(
        messages.some((message) =>
          contentBlocks(message).some(
            (block) =>
              block.type === 'tool_result' &&
              block.tool_use_id === 'call_read_roundtrip' &&
              JSON.stringify(block.content).includes(fileSentinel)
          )
        )
      ).toBe(true)
      expect(resultMessage(messages)).toMatchObject({
        subtype: 'success',
        is_error: false,
        result: finalSentinel
      })
    } finally {
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 35_000)

  it('runs a real Agent subagent, exposes parent_tool_use_id, and returns its result to the parent', async () => {
    const root = await makeTempRoot('agent')
    const subagentPrompt = 'SUBAGENT_PROMPT_SENTINEL_92ab'
    const subagentResult = 'SUBAGENT_RESULT_SENTINEL_d134'
    const parentResult = 'PARENT_AGENT_CONTINUATION_COMPLETE_f620'
    const captured: CapturedRequest[] = []

    const fakeFetch: typeof fetch = async (_input, init) => {
      const request = captureRequest(init)
      captured.push(request)
      const agentOutput = functionOutput(request.body, 'call_agent_roundtrip')
      if (agentOutput !== undefined) return textResponse('resp_agent_parent_final', parentResult)
      if (JSON.stringify(request.body.input).includes(subagentPrompt)) {
        return textResponse('resp_agent_child', subagentResult)
      }
      if (toolNames(request.body).includes('Agent')) {
        return functionCallResponse('resp_agent_tool', 'call_agent_roundtrip', 'Agent', {
          description: 'Run deterministic SDK probe',
          prompt: `${subagentPrompt}. Return the response you receive.`,
          subagent_type: 'probe',
          run_in_background: false
        })
      }
      return textResponse('resp_agent_auxiliary', 'auxiliary request complete')
    }
    const server = await startCodexProxyServer({
      getTokens: async () => tokens,
      refreshTokens: async () => tokens,
      secret: SECRET,
      fetchImpl: fakeFetch
    })

    try {
      const messages = await collectQuery(
        'Delegate this deterministic probe to the configured subagent.',
        sdkOptions(root, server.port, {
          tools: ['Agent'],
          agents: {
            probe: {
              description: 'Returns a deterministic integration-test response.',
              prompt: 'Complete the exact prompt and return the model response.',
              tools: []
            }
          },
          forwardSubagentText: true,
          maxTurns: 6
        })
      )

      const parentContinuation = captured.find(
        (request) => functionOutput(request.body, 'call_agent_roundtrip') !== undefined
      )
      const childRequest = captured.find(
        (request) =>
          functionOutput(request.body, 'call_agent_roundtrip') === undefined &&
          JSON.stringify(request.body.input).includes(subagentPrompt)
      )
      expect(parentContinuation).toBeDefined()
      expect(childRequest).toBeDefined()
      expect(functionOutput(parentContinuation!.body, 'call_agent_roundtrip')).toContain(subagentResult)
      expect(childRequest!.body.model).toBe(MODEL)
      expect(new Set(captured.map((request) => request.sessionId)).size).toBe(1)

      expect(
        messages.some((message) =>
          contentBlocks(message).some(
            (block) => block.type === 'tool_use' && block.id === 'call_agent_roundtrip' && block.name === 'Agent'
          )
        )
      ).toBe(true)
      expect(
        messages.some(
          (message) =>
            'parent_tool_use_id' in message &&
            message.parent_tool_use_id === 'call_agent_roundtrip' &&
            JSON.stringify(message).includes(subagentResult)
        )
      ).toBe(true)
      expect(resultMessage(messages)).toMatchObject({
        subtype: 'success',
        is_error: false,
        result: parentResult
      })
    } finally {
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 35_000)

  it('stops a repeated real Read loop at the proxy per-turn boundary', async () => {
    const root = await makeTempRoot('loop')
    const fixturePath = join(root, 'loop.txt')
    const fileSentinel = 'MAX_TURNS_READ_SENTINEL_31ea'
    await writeFile(fixturePath, fileSentinel, 'utf8')
    const captured: CapturedRequest[] = []

    const fakeFetch: typeof fetch = async (_input, init) => {
      const request = captureRequest(init)
      captured.push(request)
      const next = captured.length
      return functionCallResponse(`resp_loop_${next}`, `call_loop_${next}`, 'Read', {
        file_path: fixturePath
      })
    }
    const server = await startCodexProxyServer({
      getTokens: async () => tokens,
      refreshTokens: async () => tokens,
      secret: SECRET,
      fetchImpl: fakeFetch,
      maxToolRounds: 2
    })

    try {
      let loopError: unknown
      let loopMessages: SDKMessage[] = []
      try {
        loopMessages = await collectQuery(
          'Keep reading loop.txt.',
          sdkOptions(root, server.port, { tools: ['Read'], maxTurns: 6 })
        )
      } catch (error) {
        loopError = error
      }

      expect(captured).toHaveLength(2)
      expect(functionOutput(captured[1].body, 'call_loop_1')).toContain(fileSentinel)
      if (loopError instanceof Error) {
        expect(loopError.message).toMatch(/tool-call loop|400|invalid_request/i)
      } else {
        expect(resultMessage(loopMessages)).toMatchObject({
          is_error: true
        })
        expect(JSON.stringify(resultMessage(loopMessages))).toMatch(/tool-call loop|400|invalid_request/i)
      }
    } finally {
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 35_000)
})
