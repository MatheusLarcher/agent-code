import { describe, it, expect } from 'vitest'
import type { ChatEvent } from '@shared/ipc'
import {
  closeRunningTracks,
  isSubagentEvent,
  MAX_STEPS,
  reduceTracks,
  sortTracks,
  type TrackMap
} from './agentTracks'

const taskCall = (id: string, description: string): ChatEvent => ({
  kind: 'tool-use',
  id,
  name: 'Task',
  input: { description, prompt: 'faz aí', subagent_type: 'Explore' },
  parentToolUseId: null
})

const subCall = (id: string, parent: string, name: string, extra: Record<string, unknown> = {}): ChatEvent => ({
  kind: 'tool-use',
  id,
  name,
  input: { file_path: 'a.ts' },
  parentToolUseId: parent,
  ...extra
})

const subResult = (toolUseId: string, parent: string, text = 'ok', isError = false): ChatEvent => ({
  kind: 'tool-result',
  id: `r-${toolUseId}`,
  toolUseId,
  isError,
  text,
  parentToolUseId: parent
})

const taskResult = (toolUseId: string, isError = false): ChatEvent => ({
  kind: 'tool-result',
  id: `r-${toolUseId}`,
  toolUseId,
  isError,
  text: 'relatório final',
  parentToolUseId: null
})

function fold(events: ChatEvent[], map: TrackMap = {}): TrackMap {
  return events.reduce((acc, e) => reduceTracks(acc, e), map)
}

describe('isSubagentEvent', () => {
  it('separa o trabalho de subagente do que é do agente principal', () => {
    expect(isSubagentEvent(subCall('t1', 'task-1', 'Read'))).toBe(true)
    expect(isSubagentEvent(subResult('t1', 'task-1'))).toBe(true)
    expect(isSubagentEvent(taskCall('task-1', 'procurar X'))).toBe(false)
    expect(isSubagentEvent(taskResult('task-1'))).toBe(false)
    expect(isSubagentEvent({ kind: 'assistant-text', id: 'a', text: 'oi', final: true })).toBe(false)
  })
})

describe('reduceTracks', () => {
  it('abre a trilha tanto no nome novo (Agent) quanto no antigo (Task)', () => {
    const comAgent = fold([{ ...taskCall('a1', 'varrer imports'), name: 'Agent' } as ChatEvent])
    expect(comAgent['a1'].status).toBe('running')
    const comTask = fold([taskCall('t1', 'varrer imports')])
    expect(comTask['t1'].status).toBe('running')
    // Ferramenta comum do agente principal não vira trilha.
    expect(fold([{ ...taskCall('x1', 'nada'), name: 'Read' } as ChatEvent])).toEqual({})
  })

  it('a chamada Task abre a trilha com rótulo legível', () => {
    const map = fold([taskCall('task-1', 'procurar onde o plano é montado')])
    expect(map['task-1'].label).toContain('procurar onde o plano é montado')
    expect(map['task-1'].status).toBe('running')
    expect(map['task-1'].stepCount).toBe(0)
  })

  it('as chamadas do subagente entram na trilha, não no chat', () => {
    const map = fold([
      taskCall('task-1', 'procurar X'),
      subCall('s1', 'task-1', 'Read'),
      subCall('s2', 'task-1', 'Grep'),
      subResult('s1', 'task-1', 'conteúdo do arquivo')
    ])
    const track = map['task-1']
    expect(track.stepCount).toBe(2)
    expect(track.steps.map((s) => s.name)).toEqual(['Read', 'Grep'])
    expect(track.steps[0].result).toBe('conteúdo do arquivo')
    expect(track.steps[0].endedAt).toBeTypeOf('number')
  })

  it('o resultado da Task fecha a trilha', () => {
    const map = fold([taskCall('task-1', 'procurar X'), subCall('s1', 'task-1', 'Read'), taskResult('task-1')])
    expect(map['task-1'].status).toBe('done')
    expect(map['task-1'].endedAt).toBeTypeOf('number')
  })

  it('Task com erro fecha a trilha como erro', () => {
    const map = fold([taskCall('task-1', 'procurar X'), taskResult('task-1', true)])
    expect(map['task-1'].status).toBe('error')
  })

  it('adota subagente cuja Task não foi vista (app reconectou no meio)', () => {
    const map = fold([
      subCall('s1', 'task-perdida', 'Bash', { subagentType: 'Explore', taskDescription: 'auditar imports' })
    ])
    expect(map['task-perdida'].label).toBe('Explore: auditar imports')
    expect(map['task-perdida'].status).toBe('running')
    expect(map['task-perdida'].stepCount).toBe(1)
  })

  it('rótulo melhor chegando depois substitui o provisório', () => {
    const map = fold([
      subCall('s1', 'task-1', 'Read'),
      subCall('s2', 'task-1', 'Grep', { subagentType: 'Explore', taskDescription: 'mapear rotas' })
    ])
    expect(map['task-1'].label).toBe('Explore: mapear rotas')
  })

  it('não deixa a trilha crescer sem limite (mas o contador é real)', () => {
    const events: ChatEvent[] = [taskCall('task-1', 'muita coisa')]
    for (let i = 0; i < MAX_STEPS + 25; i++) events.push(subCall(`s${i}`, 'task-1', 'Read'))
    const track = fold(events)['task-1']
    expect(track.steps).toHaveLength(MAX_STEPS)
    expect(track.stepCount).toBe(MAX_STEPS + 25)
    expect(track.steps[track.steps.length - 1].id).toBe(`s${MAX_STEPS + 24}`) // manteve o fim, não o começo
  })

  it('evento que não é de trilha devolve o MESMO objeto (evita re-render à toa)', () => {
    const map = fold([taskCall('task-1', 'procurar X')])
    expect(reduceTracks(map, { kind: 'assistant-text', id: 'a', text: 'oi', final: false })).toBe(map)
    expect(reduceTracks(map, { kind: 'thinking', id: 't', text: 'hmm' })).toBe(map)
  })

  it('resultado de trilha desconhecida não cria lixo', () => {
    expect(reduceTracks({}, subResult('s1', 'task-fantasma'))).toEqual({})
    expect(reduceTracks({}, taskResult('task-fantasma'))).toEqual({})
  })
})

describe('sortTracks / closeRunningTracks', () => {
  it('rodando primeiro, depois as mais recentes', () => {
    let map = fold([taskCall('t1', 'primeira'), taskCall('t2', 'segunda')])
    map = reduceTracks(map, taskResult('t2'))
    const order = sortTracks(map).map((t) => t.id)
    expect(order[0]).toBe('t1') // a que ainda roda vem antes
  })

  it('fim de turno não deixa ninguém girando pra sempre', () => {
    const map = fold([taskCall('t1', 'primeira'), taskCall('t2', 'segunda')])
    const closed = closeRunningTracks(map)
    expect(Object.values(closed).every((t) => t.status === 'done')).toBe(true)
    // Nada a fechar → mesmo objeto de volta.
    expect(closeRunningTracks(closed)).toBe(closed)
  })
})
