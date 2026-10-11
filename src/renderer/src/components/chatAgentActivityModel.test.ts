import { describe, expect, it } from 'vitest'
import type { AgentTrack, TrackStep } from '../agentTracks'
import { activityState, agentName, currentActivity, safeStepMessages, safeSummary, taskText } from './chatAgentActivityModel'

const step = (over: Partial<TrackStep>): TrackStep => ({ id: 's1', name: 'Read', input: { file_path: 'C:/p/src/a.ts' }, startedAt: 1, ...over })
const track = (over: Partial<AgentTrack>): AgentTrack => ({
  id: 't1', label: 'Explore: achar o reducer', subagentType: 'Explore', status: 'running', startedAt: 1, stepCount: 0, steps: [], ...over
})

describe('chatAgentActivityModel', () => {
  it('estado: trabalhando com ação em voo, aguardando sem ação em voo, concluído, interrompido e erro', () => {
    expect(activityState(track({}))).toBe('aguardando')
    expect(activityState(track({ stepCount: 1, steps: [step({})] }))).toBe('trabalhando')
    expect(activityState(track({ stepCount: 1, steps: [step({ endedAt: 2, result: 'ok' })] }))).toBe('aguardando')
    expect(activityState(track({ status: 'done', endedAt: 3 }))).toBe('concluido')
    expect(activityState(track({ status: 'done', endedAt: 3, task: { id: 'k', status: 'stopped' } }))).toBe('interrompido')
    expect(activityState(track({ status: 'error', endedAt: 3 }))).toBe('erro')
  })

  it('nome e tarefa: o tipo vira o nome e sai do rótulo; sem tipo, "Subagente"', () => {
    expect(agentName(track({}))).toBe('Explore')
    expect(taskText(track({}))).toBe('achar o reducer')
    expect(agentName(track({ subagentType: undefined, label: 'revisar o diff' }))).toBe('Subagente')
    expect(taskText(track({ subagentType: undefined, label: 'revisar o diff' }))).toBe('revisar o diff')
  })

  it('atividade atual sai da última chamada de ferramenta', () => {
    expect(currentActivity(track({}))).toBe('Iniciando…')
    expect(currentActivity(track({ steps: [step({ endedAt: 2 }), step({ id: 's2', name: 'Grep', input: { pattern: 'reduceTracks' } })] }))).toBe('Agora: busca reduceTracks')
    expect(currentActivity(track({ steps: [step({ endedAt: 2 })] }))).toBe('Última ação: leu src/a.ts')
    expect(currentActivity(track({ task: { id: 'k', status: 'running', lastToolName: 'Bash' } }))).toBe('Última ação: bash')
    expect(currentActivity(track({ status: 'done', steps: [step({ endedAt: 2 })] }))).toBe('Última ação: leu src/a.ts')
  })

  it('não expõe segredos: valor do cofre some e placeholders viram só o nome', () => {
    const t = track({
      steps: [
        step({ id: 'a', name: 'mcp__memory__memory_secret_get', input: { name: 'api' }, endedAt: 2, result: 'sk-live-123' }),
        step({ id: 'b', name: 'Bash', input: { command: 'echo' }, endedAt: 3, result: 'token ⟦senha:api⟧ ok' }),
        step({ id: 'c', name: 'Read', input: { file_path: 'x' } })
      ],
      task: { id: 'k', status: 'completed', summary: 'usei ⟦senha:db⟧' }
    })
    const msgs = safeStepMessages(t)
    expect(msgs.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(JSON.stringify(msgs)).not.toContain('sk-live-123')
    expect(msgs[0].result?.text).toBe('[valor do cofre oculto]')
    expect(msgs[1].result?.text).toBe('token [senha: api] ok')
    expect(msgs[2].result).toBeUndefined()
    expect(safeSummary(t)).toBe('usei [senha: db]')
    expect(safeSummary(track({}))).toBeUndefined()
  })
})
