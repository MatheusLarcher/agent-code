import { describe, expect, it } from 'vitest'
import type { AgentTrack } from '../agentTracks'
import { remoteSubagents, remoteSubagentsKey } from './remoteSubagents'

const track = (over: Partial<AgentTrack> = {}): AgentTrack => ({
  id: 't1',
  label: 'executor: implementar o login',
  subagentType: 'executor',
  status: 'running',
  startedAt: 1000,
  stepCount: 2,
  steps: [{ id: 's1', name: 'Bash', input: { command: 'npm test' }, startedAt: 1500 }],
  ...over
})

describe('remoteSubagents', () => {
  it('só os rodando, do mais antigo ao mais novo: papel, resumo e início — nunca a ferramenta', () => {
    const list = remoteSubagents({
      b: track({ id: 'b', subagentType: 'critico', startedAt: 3000 }),
      a: track({ id: 'a', startedAt: 2000, task: { id: 'k', status: 'running', lastToolName: 'Read', summary: ' Analisando o módulo de autenticação ' } }),
      fim: track({ id: 'fim', status: 'done', endedAt: 4000 })
    })
    expect(list).toEqual([
      { id: 'a', label: 'Executor', summary: 'Analisando o módulo de autenticação', startedAt: 2000 },
      { id: 'b', label: 'Crítico', startedAt: 3000 }
    ])
  })

  it('subagente fora do cadastro leva a descrição da tarefa; sem nenhum rodando, nada', () => {
    expect(remoteSubagents({ x: track({ id: 'x', subagentType: 'Explore', label: 'Explore: onde o plano é montado' }) })).toEqual([
      { id: 'x', label: 'Explore: onde o plano é montado', startedAt: 1000 }
    ])
    expect(remoteSubagents({ fim: track({ status: 'error' }) })).toBeUndefined()
    expect(remoteSubagents(undefined)).toBeUndefined()
  })
})

describe('remoteSubagentsKey', () => {
  it('muda com subagente novo ou resumo novo; uma ferramenta nova não muda nada', () => {
    const base = remoteSubagents({ a: track({ id: 'a' }) })
    const outraFerramenta = remoteSubagents({ a: track({ id: 'a', stepCount: 3, steps: [{ id: 's2', name: 'Edit', input: {}, startedAt: 1800 }] }) })
    const comResumo = remoteSubagents({ a: track({ id: 'a', task: { id: 'k', status: 'running', summary: 'Rodando os testes' } }) })
    const doisRodando = remoteSubagents({ a: track({ id: 'a' }), b: track({ id: 'b', startedAt: 2000 }) })
    expect(remoteSubagentsKey(outraFerramenta)).toBe(remoteSubagentsKey(base))
    expect(remoteSubagentsKey(comResumo)).not.toBe(remoteSubagentsKey(base))
    expect(remoteSubagentsKey(doisRodando)).not.toBe(remoteSubagentsKey(base))
    expect(remoteSubagentsKey(undefined)).toBe('')
  })
})
