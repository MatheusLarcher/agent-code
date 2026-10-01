// Fixtures dos testes do adaptador (não é usado pelo app).
import type { AgentTrack } from '../../agentTracks'
import type { Conversation, UIMessage } from '../../types'
import type { OfficeFeed } from './feed'

export const NOW = 1_800_000_000_000
export const HOUR = 60 * 60 * 1000

export function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: id,
    cwd: 'C:\\proj\\alpha',
    model: 'claude-opus-4-5',
    sdkSessionId: null,
    messages: [],
    tokens: { context: 0, output: 0, cost: 0 },
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    ...over
  }
}

export function feed(over: Partial<OfficeFeed> = {}): OfficeFeed {
  return {
    conversations: [],
    activeId: null,
    busyIds: new Set(),
    busySince: {},
    permissions: {},
    vigiaAlerts: {},
    vigiaAt: {},
    poDiagnostics: {},
    memoristaDiagnostics: {},
    observersOn: { po: true, vigia: true, memorista: true },
    stalledSince: {},
    tracks: {},
    projectIcons: {},
    ...over
  }
}

export function track(id: string, over: Partial<AgentTrack> = {}): AgentTrack {
  return {
    id,
    label: `executor: ${id}`,
    subagentType: 'executor',
    status: 'running',
    startedAt: NOW - 60_000,
    stepCount: 1,
    steps: [{ id: `${id}-s`, name: 'Bash', input: { command: 'npm test' }, startedAt: NOW - 10_000 }],
    ...over
  }
}

export const user = (id: string, error?: string): UIMessage => ({ kind: 'user', id, text: 'oi', ...(error ? { error } : {}) })

export function toolUse(id: string, name: string, input: unknown, result?: boolean): UIMessage {
  return {
    kind: 'tool-use',
    id,
    name,
    input,
    parentToolUseId: null,
    ...(result ? { result: { isError: false, text: 'ok' } } : {})
  }
}
