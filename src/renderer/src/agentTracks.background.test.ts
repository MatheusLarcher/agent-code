import { describe, it, expect } from 'vitest'
import type { AgentTaskInfo, AgentTaskPhase, ChatEvent } from '@shared/ipc'
import { closeRunningTracks, reduceTracks, type TrackMap } from './agentTracks'

// A sequência abaixo é a de um run real (Haiku, Agent com run_in_background):
// tool_use Agent → background_tasks_changed → task_started (is_backgrounded) →
// tool_result "Async agent launched…" → result do turno → passos do subagente
// com parent_tool_use_id + task_progress → background_tasks_changed [] →
// task_updated completed → task_notification.
const AGENT = 'toolu_agent'
const TASK = 'aba3ef3e1cceb2488'

const agentCall: ChatEvent = {
  kind: 'tool-use',
  id: AGENT,
  name: 'Agent',
  input: { subagent_type: 'pinger', run_in_background: true, description: 'ping', prompt: 'go' },
  parentToolUseId: null
}
const launched: ChatEvent = {
  kind: 'tool-result',
  id: 'r-agent',
  toolUseId: AGENT,
  isError: false,
  text: 'Async agent launched successfully. (This tool result is internal metadata…)',
  parentToolUseId: null
}
const task = (phase: AgentTaskPhase, info: Partial<AgentTaskInfo> = {}): ChatEvent => ({
  kind: 'agent-task',
  phase,
  taskId: TASK,
  toolUseId: AGENT,
  status: 'running',
  ...info
})
const snapshot = (ids: string[]): ChatEvent => ({
  kind: 'background-tasks',
  tasks: ids.map((id) => ({ id, type: 'local_agent', description: 'ping' }))
})
const step = (id: string): ChatEvent => ({ kind: 'tool-use', id, name: 'Bash', input: { command: 'echo one' }, parentToolUseId: AGENT })
const stepResult = (id: string): ChatEvent => ({ kind: 'tool-result', id: `r-${id}`, toolUseId: id, isError: false, text: 'one', parentToolUseId: AGENT })

const fold = (events: ChatEvent[], map: TrackMap = {}): TrackMap => events.reduce((acc, e) => reduceTracks(acc, e), map)

describe('subagente em segundo plano', () => {
  it('o tool_result de lançamento não fecha a trilha; passos entram; a notificação fecha', () => {
    let map = fold([agentCall, snapshot([TASK]), task('started', { backgrounded: true, subagentType: 'pinger' }), launched])
    expect(map[AGENT]).toMatchObject({ status: 'running', background: true, task: { id: TASK, status: 'running' } })

    // Fim do turno principal: a trilha em segundo plano continua.
    map = closeRunningTracks(map, 1, true)
    expect(map[AGENT].status).toBe('running')

    map = fold([step('s1'), task('progress', { lastToolName: 'Bash', toolUses: 1 }), stepResult('s1')], map)
    expect(map[AGENT].status).toBe('running')
    expect(map[AGENT].stepCount).toBe(1)
    expect(map[AGENT].steps[0]).toMatchObject({ id: 's1', name: 'Bash', result: 'one' })
    expect(map[AGENT].task).toMatchObject({ lastToolName: 'Bash', toolUses: 1 })

    map = fold([snapshot([]), task('updated', { status: 'completed' }), task('notification', { status: 'completed', summary: 'ok', toolUses: 2 })], map)
    expect(map[AGENT]).toMatchObject({ status: 'done', task: { status: 'completed', summary: 'ok', toolUses: 2, lastToolName: 'Bash' } })
    expect(map[AGENT].endedAt).toBeDefined()
  })

  it('reconhece o lançamento pelo texto mesmo sem o task_started antes', () => {
    const map = fold([agentCall, launched])
    expect(map[AGENT]).toMatchObject({ status: 'running', background: true })
  })

  it('falha e parada fecham com o status certo', () => {
    const base = fold([agentCall, task('started', { backgrounded: true }), launched])
    expect(reduceTracks(base, task('notification', { status: 'failed' }))[AGENT].status).toBe('error')
    const stopped = reduceTracks(base, task('notification', { status: 'stopped' }))[AGENT]
    expect(stopped).toMatchObject({ status: 'done', task: { status: 'stopped' } })
  })

  it('fim pelo hook e depois a correção do SDK: o status muda, a hora do fim fica', () => {
    const base = fold([agentCall, task('started', { backgrounded: true }), launched])
    const byHook = reduceTracks(base, task('notification', { status: 'completed' }), 100)
    const fixed = reduceTracks(byHook, task('notification', { status: 'failed' }), 200)
    expect(fixed[AGENT]).toMatchObject({ status: 'error', endedAt: 100 })
  })

  it('o snapshot sem a tarefa fecha a trilha (fim perdido); com ela, nada muda', () => {
    const base = fold([agentCall, task('started', { backgrounded: true }), launched])
    expect(reduceTracks(base, snapshot([TASK]))).toBe(base)
    expect(reduceTracks(base, snapshot([]))[AGENT].status).toBe('done')
  })

  it('trilha fechada antes da hora (erro do turno) volta a rodar com o progresso; a terminada não', () => {
    let map = fold([agentCall, task('started', { backgrounded: true }), launched])
    map = closeRunningTracks(map, 1)
    expect(map[AGENT].status).toBe('done')
    map = reduceTracks(map, task('progress', { lastToolName: 'Read' }))
    expect(map[AGENT].status).toBe('running')
    expect(map[AGENT].endedAt).toBeUndefined()

    const done = reduceTracks(map, task('notification', { status: 'completed' }))
    expect(reduceTracks(done, task('progress'))[AGENT].status).toBe('done')
  })

  it('primeiro plano continua como antes: o tool_result fecha', () => {
    const map = fold([agentCall, task('started', { backgrounded: false }), { ...launched, text: 'relatório final' } as ChatEvent])
    expect(map[AGENT].status).toBe('done')
  })

  it('tarefa sem trilha (shell em segundo plano) não abre nada', () => {
    const map = fold([agentCall])
    expect(reduceTracks(map, { kind: 'agent-task', phase: 'started', taskId: 'b1', toolUseId: 'toolu_bash', status: 'running' })).toBe(map)
  })
})
