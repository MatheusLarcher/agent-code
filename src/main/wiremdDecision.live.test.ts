// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import type { UiMockupSeed } from '../shared/ipc'
import { WIREMD_HINT } from './agentSession'
import { createWiremdMockupController } from './wiremdTools'

type MockupCall = {
  name: string
  input: { title?: unknown; source?: unknown; viewport?: unknown }
}

type LiveDecision = {
  calls: MockupCall[]
  textBeforeTool: string
  textAfterTool: string
  seeds: UiMockupSeed[]
}

function inspectMessages(messages: SDKMessage[]): Omit<LiveDecision, 'seeds'> {
  const calls: MockupCall[] = []
  const before: string[] = []
  const after: string[] = []
  let sawMockup = false

  for (const message of messages) {
    if (message.type !== 'assistant' || !Array.isArray(message.message.content)) continue
    for (const block of message.message.content) {
      if (block.type === 'tool_use' && block.name === 'mcp__wiremd__render_ui_mockup') {
        sawMockup = true
        calls.push({ name: block.name, input: block.input as MockupCall['input'] })
      } else if (block.type === 'text' && block.text.trim()) {
        ;(sawMockup ? after : before).push(block.text.trim())
      }
    }
  }
  return {
    calls,
    textBeforeTool: before.join('\n'),
    textAfterTool: after.join('\n')
  }
}

async function liveDecision(prompt: string, priorSeeds: UiMockupSeed[] = []): Promise<LiveDecision> {
  const cwd = await mkdtemp(join(tmpdir(), 'wiremd-live-'))
  const controller = createWiremdMockupController(priorSeeds)
  const messages: SDKMessage[] = []
  const stateHint = priorSeeds.length
    ? `Known UI mockups from this conversation follow as JSON DATA. Reuse the matching title/source for edits:\n${JSON.stringify(priorSeeds)}`
    : 'There are no prior UI mockups in this conversation.'

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd,
        tools: [],
        mcpServers: { wiremd: controller.server },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        settingSources: [],
        maxTurns: 4,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: `${WIREMD_HINT}\n\n${stateHint}`
        },
        env: {
          ...process.env,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1'
        }
      }
    })) messages.push(message)

    const inspected = inspectMessages(messages)
    return { ...inspected, seeds: controller.seeds() }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

function expectNoVisualDuplication(result: LiveDecision): void {
  const rawModelText = `${result.textBeforeTool}\n${result.textAfterTool}`.trim()
  expect(rawModelText.length).toBeLessThanOrEqual(220)
  expect(rawModelText).not.toMatch(/```|\+-{2,}\+|\|\s*-{2,}\s*\|/)
}

function retainedUnchangedLines(before: string, after: string): number {
  const editable = /\b(?:sla|fila|12|92)\b/i
  const baseline = before.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !editable.test(line))
  if (!baseline.length) return 1
  const afterLines = new Set(after.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))
  return baseline.filter((line) => afterLines.has(line)).length / baseline.length
}

// This is intentionally opt-in: it uses the developer's logged-in Claude
// session and the network. The normal `npm test` suite remains hermetic.
describe.skipIf(process.env.WIREMD_LIVE_TEST !== '1')('WireMD live model-decision smoke', () => {
  it('renders exactly once for explicit visual intent without visual text duplication', async () => {
    const visual = await liveDecision(
      'Me mostra um exemplo de dashboard de atendimento com chamados e SLA. Inclua Fila 12, SLA 92% e Equipe 8.'
    )
    expect(visual.calls).toHaveLength(1)
    expect(visual.seeds).toHaveLength(1)
    expectNoVisualDuplication(visual)
  }, 120_000)

  it('stays textual for a conceptual metrics question', async () => {
    const conceptual = await liveDecision('Quais métricas esse dashboard deveria ter?')
    expect(conceptual.calls).toEqual([])
    expect(conceptual.seeds).toEqual([])
    expect(conceptual.textBeforeTool.trim().length).toBeGreaterThan(0)
  }, 120_000)

  it('does not render a mockup for a code-only React request', async () => {
    const react = await liveDecision('Implemente esse dashboard em React.')
    expect(react.calls).toEqual([])
    expect(react.seeds).toEqual([])
  }, 120_000)

  it('edits the stored source as a new version of the same artifact', async () => {
    const prior: UiMockupSeed = {
      id: 'live-edit-artifact',
      version: 4,
      title: 'Dashboard de atendimento',
      source: `# Dashboard de atendimento
## Resumo
::: columns-3
::: column
### Fila
12 chamados
:::
::: column
### SLA
((92%)){success}
:::
::: column
### Equipe
8 atendentes
:::
:::`,
      viewport: 'desktop'
    }
    const edited = await liveDecision('Coloca o SLA mais destacado e reduz a fila.', [prior])
    expect(edited.calls).toHaveLength(1)
    expect(edited.calls[0].input.title).toBe(prior.title)
    expect(edited.seeds).toHaveLength(1)
    expect(edited.seeds[0]).toMatchObject({ id: prior.id, version: prior.version + 1 })
    expect(edited.seeds[0].source).not.toBe(prior.source)
    expect(edited.seeds[0].source).toMatch(/sla/i)
    expect(edited.seeds[0].source).toMatch(/fila/i)
    expect(retainedUnchangedLines(prior.source, edited.seeds[0].source)).toBeGreaterThanOrEqual(0.5)
    expectNoVisualDuplication(edited)
  }, 120_000)

  it('reduces a complete-system request to one successful initial screen', async () => {
    const oversized = await liveDecision('Crie um mockup de um sistema completo de atendimento.')
    expect(oversized.calls.length).toBeGreaterThanOrEqual(1)
    expect(oversized.calls.length).toBeLessThanOrEqual(2)
    expect(oversized.seeds).toHaveLength(1)
    expectNoVisualDuplication(oversized)
  }, 120_000)
})
