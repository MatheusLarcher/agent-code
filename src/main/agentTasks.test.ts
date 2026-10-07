import { describe, it, expect } from 'vitest'
import { AgentTaskTranslator, translateTaskMessage } from './agentTasks'

// Mensagens no formato de um run real do CLI 2.1.291 (Agent com run_in_background).
const started = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'aba3ef3e1cceb2488',
  tool_use_id: 'toolu_agent',
  description: 'ping',
  subagent_type: 'pinger',
  is_backgrounded: true,
  spawn_depth: 1,
  task_type: 'local_agent',
  prompt: 'go'
}
const progress = {
  type: 'system',
  subtype: 'task_progress',
  task_id: 'aba3ef3e1cceb2488',
  tool_use_id: 'toolu_agent',
  description: 'Running Output "one"',
  subagent_type: 'pinger',
  usage: { total_tokens: 5428, tool_uses: 1, duration_ms: 1930 },
  last_tool_name: 'Bash'
}
const updated = { type: 'system', subtype: 'task_updated', task_id: 'aba3ef3e1cceb2488', patch: { status: 'completed', end_time: 1 } }
const notification = {
  type: 'system',
  subtype: 'task_notification',
  task_id: 'aba3ef3e1cceb2488',
  tool_use_id: 'toolu_agent',
  status: 'completed',
  output_file: 'x.output',
  summary: 'ok',
  usage: { total_tokens: 6304, tool_uses: 2, duration_ms: 10 }
}

describe('translateTaskMessage', () => {
  it('traduz o ciclo inteiro de um subagente em segundo plano', () => {
    const t = new AgentTaskTranslator()
    expect(t.translate(started)).toEqual({
      kind: 'agent-task', phase: 'started', taskId: 'aba3ef3e1cceb2488', toolUseId: 'toolu_agent',
      status: 'running', backgrounded: true, taskType: 'local_agent', subagentType: 'pinger', description: 'ping'
    })
    expect(t.translate(progress)).toEqual({
      kind: 'agent-task', phase: 'progress', taskId: 'aba3ef3e1cceb2488', toolUseId: 'toolu_agent',
      status: 'running', subagentType: 'pinger', description: 'Running Output "one"', lastToolName: 'Bash', toolUses: 1
    })
    // task_updated não traz tool_use_id: vem do task_started.
    expect(t.translate(updated)).toEqual({
      kind: 'agent-task', phase: 'updated', taskId: 'aba3ef3e1cceb2488', toolUseId: 'toolu_agent', status: 'completed'
    })
    expect(t.translate(notification)).toEqual({
      kind: 'agent-task', phase: 'notification', taskId: 'aba3ef3e1cceb2488', toolUseId: 'toolu_agent',
      status: 'completed', summary: 'ok', toolUses: 2
    })
  })

  it('normaliza os status do patch e da notificação', () => {
    const known = new Map([['t1', 'toolu_1']])
    const patch = (patch: Record<string, unknown>) => translateTaskMessage({ type: 'system', subtype: 'task_updated', task_id: 't1', patch }, known)
    expect(patch({ status: 'killed' })?.status).toBe('stopped')
    known.set('t1', 'toolu_1')
    expect(patch({ status: 'paused' })?.status).toBe('running')
    expect(patch({ status: 'failed' })?.status).toBe('failed')
    known.set('t1', 'toolu_1')
    // Primeiro plano movido para o segundo: sem status, só a flag.
    expect(patch({ is_backgrounded: true })).toMatchObject({ status: 'running', backgrounded: true, toolUseId: 'toolu_1' })
    // Patch só de tempo: nada a dizer.
    expect(patch({ end_time: 5 })).toBeNull()
    // Status desconhecido na notificação vira "completed" (a tarefa acabou de todo jeito).
    expect(translateTaskMessage({ ...notification, status: 'weird' }, new Map())?.status).toBe('completed')
  })

  it('tolera campos ausentes ou de tipo errado e ignora o que não é ciclo de tarefa', () => {
    const known = new Map<string, string>()
    expect(translateTaskMessage({ type: 'system', subtype: 'task_progress', task_id: 'x', usage: 'nope', last_tool_name: 42 }, known)).toEqual({
      kind: 'agent-task', phase: 'progress', taskId: 'x', status: 'running'
    })
    expect(translateTaskMessage({ type: 'system', subtype: 'task_started' }, known)).toBeNull()
    expect(translateTaskMessage({ type: 'system', subtype: 'init' }, known)).toBeNull()
    expect(translateTaskMessage({ type: 'assistant' }, known)).toBeNull()
    expect(translateTaskMessage(null, known)).toBeNull()
    // Tarefa ambiente: o SDK pede para não contar como atividade.
    expect(translateTaskMessage({ ...started, ambient: true }, known)).toBeNull()
  })

  it('hook: fecha pelo task_started conhecido; dedupe com o SDK nos dois sentidos', () => {
    const t = new AgentTaskTranslator()
    t.translate(started)
    const stop = { hook_event_name: 'SubagentStop', agent_id: 'aba3ef3e1cceb2488', agent_type: 'pinger', agent_transcript_path: 'x', stop_hook_active: false }
    expect(t.fromSubagentStop(stop)).toEqual({ kind: 'agent-task', phase: 'notification', taskId: 'aba3ef3e1cceb2488', toolUseId: 'toolu_agent', status: 'completed' })
    expect(t.fromSubagentStop(stop)).toBeNull()
    expect(t.translate(notification)).toBeNull()
    expect(t.translate({ ...notification, status: 'stopped' })?.status).toBe('stopped')
    // Entrada que não é SubagentStop, ou sem agent_id: nada.
    expect(t.fromSubagentStop({ hook_event_name: 'Stop' })).toBeNull()
    expect(t.fromSubagentStop({ hook_event_name: 'SubagentStop' })).toBeNull()
    expect(t.fromSubagentStop(null)).toBeNull()
  })

  it('hook: correlação passo ↔ PreToolUse ignora lixo e não sobrescreve o task_started', () => {
    const t = new AgentTaskTranslator()
    t.noteSteps([{ type: 'text' }, null, { type: 'tool_use', id: 'p1' }], 'toolu_A')
    t.noteSteps('nope', 'toolu_A')
    t.noteHookTool('ag', 42)
    t.noteHookTool('ag', 'desconhecido')
    expect(t.fromSubagentStop({ hook_event_name: 'SubagentStop', agent_id: 'ag' })).toBeNull()
    t.noteHookTool('ag', 'p1')
    expect(t.fromSubagentStop({ hook_event_name: 'SubagentStop', agent_id: 'ag' })?.toolUseId).toBe('toolu_A')

    const u = new AgentTaskTranslator()
    u.translate(started)
    u.noteSteps([{ type: 'tool_use', id: 'p2' }], 'toolu_outro')
    u.noteHookTool('aba3ef3e1cceb2488', 'p2')
    expect(u.fromSubagentStop({ hook_event_name: 'SubagentStop', agent_id: 'aba3ef3e1cceb2488' })?.toolUseId).toBe('toolu_agent')
  })

  it('esquece a tarefa quando ela termina', () => {
    const known = new Map<string, string>()
    translateTaskMessage(started, known)
    expect(known.get('aba3ef3e1cceb2488')).toBe('toolu_agent')
    translateTaskMessage(notification, known)
    expect(known.size).toBe(0)
  })
})
