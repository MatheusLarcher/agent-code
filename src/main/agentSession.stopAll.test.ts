// @vitest-environment node
// O Stop do usuário para TUDO (userStopFence.ts): a mensagem parada não volta pela
// fila durável — o `result` de erro do Stop a devolvia para `pending`, ela era
// reenviada e o agente recomeçava a tarefa chamando o próximo subagente — e os
// subagentes/tarefas de fundo vivos são pedidos ao `stopTask`.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserController } from './browserController'

vi.mock('./sessionLog', () => ({ logSession: vi.fn() }))

import { AgentSession } from './agentSession'

type Internals = {
  handleMessage(m: unknown): void
  drainPersistedInputs(): Promise<void>
  input: { push: (value: unknown) => void }
  q: unknown
}

afterEach(() => vi.clearAllMocks())

/** Stop pega o item 11 em processamento; o CLI fecha o turno com `result` de erro. */
async function setup() {
  const rows = [{ id: 11, message: { uuid: 'u-11', message: { content: 'faz a tarefa com agentes' } } }]
  const repo = {
    claimNextAgentInput: vi.fn(async () => rows.shift() ?? null),
    requeueAgentInput: vi.fn(async () => undefined),
    completeAgentInput: vi.fn(async () => undefined)
  }
  const s = new AgentSession(
    { convId: 'c-stop', cwd: '/p' }, {} as BrowserController, vi.fn(), vi.fn(), vi.fn(), undefined, undefined, undefined, undefined, undefined, repo as never
  )
  const internals = s as unknown as Internals
  const pushed: unknown[] = []
  internals.input.push = (value) => pushed.push(value)
  await internals.drainPersistedInputs()
  const interrupt = vi.fn(async () => ({ still_queued: [] }))
  const stopTask = vi.fn(async (_taskId: string) => undefined)
  internals.q = { interrupt, stopTask }
  return { s, repo, pushed, interrupt, stopTask, feed: (m: unknown): void => internals.handleMessage(m) }
}

const errorResult = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  duration_ms: 1,
  num_turns: 1,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  session_id: 's',
  uuid: 'r'
}
const taskStarted = (taskId: string) => ({
  type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: `tu-${taskId}`, task_type: 'local_agent', session_id: 's', uuid: `u-${taskId}`
})
const taskDone = (taskId: string) => ({ type: 'system', subtype: 'task_notification', task_id: taskId, status: 'completed', session_id: 's', uuid: `n-${taskId}` })
const background = (...ids: string[]) => ({
  type: 'system', subtype: 'background_tasks_changed', tasks: ids.map((id) => ({ task_id: id, task_type: 'local_bash', description: id })), session_id: 's', uuid: 'bg'
})
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

describe('AgentSession — o Stop para tudo', () => {
  it('a mensagem parada sai da fila durável: o `result` de erro do Stop não a reenvia', async () => {
    const { s, repo, pushed, feed } = await setup()
    expect(pushed).toHaveLength(1)
    await s.interrupt()
    feed(errorResult)
    await flush()
    expect(repo.requeueAgentInput).not.toHaveBeenCalled()
    expect(repo.completeAgentInput).toHaveBeenCalledWith(11)
    expect(pushed).toHaveLength(1)
  })

  it('erro de verdade (sem Stop) continua voltando para a fila', async () => {
    const { repo, feed } = await setup()
    feed(errorResult)
    await flush()
    expect(repo.requeueAgentInput).toHaveBeenCalledWith(11, expect.any(String))
    expect(repo.completeAgentInput).not.toHaveBeenCalled()
  })

  it('o corte do Scrum Master não descarta a mensagem (a cobrança continua a tarefa)', async () => {
    const { s, repo, feed } = await setup()
    await s.interruptForScrum()
    feed(errorResult)
    await flush()
    expect(repo.requeueAgentInput).toHaveBeenCalledWith(11, expect.any(String))
  })

  it('o Stop pede ao stopTask os subagentes e tarefas de fundo vivos, não os que já acabaram', async () => {
    const { s, feed, stopTask } = await setup()
    feed(taskStarted('a1'))
    feed(taskStarted('a2'))
    feed(taskDone('a2'))
    feed(background('b1'))
    await s.interrupt()
    expect(stopTask.mock.calls.map((c) => c[0]).sort()).toEqual(['a1', 'b1'])
  })
})
