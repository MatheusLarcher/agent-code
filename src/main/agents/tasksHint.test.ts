// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { handoffSessionEnv } from './sessionTuning'
import { MAX_PARALLEL_EXECUTORS, TASKS_HINT } from './tasksHint'

describe('TASKS_HINT — pipeline paralelo, uma revisão', () => {
  it('golden: o contrato inteiro do time', async () => {
    await expect(TASKS_HINT).toMatchFileSnapshot('./__golden__/tasks-hint.txt')
  })

  it('regras novas: paralelo até 6, mapa no prompt, crítico condicional, uma revisão, mesmo executor vivo', () => {
    expect(MAX_PARALLEL_EXECUTORS).toBe(6)
    expect(TASKS_HINT).toContain('several Agent calls in one message, up to 6 at once')
    expect(TASKS_HINT).toContain('write_scope do NOT overlap')
    expect(TASKS_HINT).toContain('CODE MAP')
    expect(TASKS_HINT).toContain('does not re-explore the project')
    expect(TASKS_HINT).toContain('INTO the task prompt (the critic and the code navigator run without CLAUDE.md)')
    expect(TASKS_HINT).toContain('only for a task with a claimed test_run in its deliverables or with 3+ files in its write_scope')
    expect(TASKS_HINT).toContain('ONE review of the whole diff')
    expect(TASKS_HINT).toContain('No "review → fixes → re-review" loop')
    expect(TASKS_HINT).toContain('preferred whenever it still exists')
  })

  it('o paralelismo é o mesmo número do teto de subagentes da conversa de handoff', () => {
    expect(handoffSessionEnv({ handoff: { slug: 'p' } }).CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS).toBe(String(MAX_PARALLEL_EXECUTORS))
  })
})

describe('handoffSessionEnv — só a conversa de implementação de handoff', () => {
  it('handoff: até 6 subagentes e compactação em 200k tokens (env, nunca o percentual)', () => {
    expect(handoffSessionEnv({ handoff: { slug: 'p' } })).toEqual({
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '6',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000'
    })
  })

  it('comum e Agent Manager: nada', () => {
    expect(handoffSessionEnv({})).toEqual({})
    expect(handoffSessionEnv({ planning: { slug: 'p' } })).toEqual({})
    expect(handoffSessionEnv({ planning: { slug: 'p' }, handoff: { slug: 'p' } })).toEqual({})
  })
})
