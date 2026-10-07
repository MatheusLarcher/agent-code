import { describe, expect, it } from 'vitest'
import { trackMessages } from '../../office3d/chatPage'
import { deriveOfficeModel, hasActiveTask, principalKey } from './model'
import { NOW, conv, feed, track } from './testFeed'

// Subagente em SEGUNDO PLANO: o turno principal já acabou (nada em busyIds),
// a trilha segue rodando até o task_notification.
const bg = track('toolu_agent', { subagentType: 'general-purpose', label: 'ping', background: true, task: { id: 'a1', status: 'running' } })

describe('subagente em segundo plano no escritório', () => {
  it('o principal tem tarefa ativa enquanto a trilha em segundo plano roda', () => {
    const c = conv('a')
    expect(hasActiveTask(c, feed({ conversations: [c], tracks: { a: { [bg.id]: bg } } }))).toBe(true)
    const done = { ...bg, status: 'done' as const, endedAt: NOW }
    expect(hasActiveTask(c, feed({ conversations: [c], tracks: { a: { [bg.id]: done } } }))).toBe(false)
  })

  it('o snapshot do SDK com subagente vivo também conta (trilha perdida num recarregamento); shell não', () => {
    const agent = conv('a', { backgroundTasks: [{ id: 'a1', type: 'local_agent', description: 'ping' }] })
    const shell = conv('b', { backgroundTasks: [{ id: 'b1', type: 'local_bash', description: 'npm run dev' }] })
    const f = feed({ conversations: [agent, shell] })
    expect(hasActiveTask(agent, f)).toBe(true)
    expect(hasActiveTask(shell, f)).toBe(false)
  })

  it('o personagem do subagente não some e trabalha; o principal fica com tarefa', () => {
    const c = conv('a', { updatedAt: NOW })
    const m = deriveOfficeModel(feed({ conversations: [c], tracks: { a: { [bg.id]: bg } } }), NOW)
    const sub = m.characters.find((x) => x.trackId === bg.id)
    expect(sub).toMatchObject({ active: true, task: true })
    expect(m.characters.find((x) => x.key === principalKey('a'))?.task).toBe(true)
  })

  it('o monitor do subagente não diz "Tarefa concluída." enquanto roda; parado diz "interrompida"', () => {
    const last = (t: typeof bg): string => {
      const m = trackMessages(t).at(-1)
      return m?.kind === 'status' ? m.text : ''
    }
    expect(last(bg)).toBe('')
    expect(trackMessages(bg).map((m) => m.kind)).toEqual(['user', 'tool-use'])
    expect(last({ ...bg, status: 'done', task: { id: 'a1', status: 'completed' } })).toBe('Tarefa concluída.')
    expect(last({ ...bg, status: 'done', task: { id: 'a1', status: 'stopped' } })).toBe('Tarefa interrompida.')
  })
})
