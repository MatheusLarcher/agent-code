import { describe, expect, it } from 'vitest'
import { isSubagentMessage, mainTrack } from './subagentMessages'

describe('subagentMessages — a trilha principal da conversa', () => {
  it('subagente = parentToolUseId preenchido; nulo, ausente ou lixo não é', () => {
    expect(isSubagentMessage({ kind: 'tool-use', parentToolUseId: 'task' })).toBe(true)
    expect(isSubagentMessage({ kind: 'tool-use', parentToolUseId: null })).toBe(false)
    expect(isSubagentMessage({ kind: 'user' })).toBe(false)
    expect(isSubagentMessage(null)).toBe(false)
    expect(isSubagentMessage('x')).toBe(false)
  })

  it('mainTrack tira o subagente; sem nenhum, devolve a MESMA lista', () => {
    const main = [{ id: 'a' }, { id: 'b', parentToolUseId: null }]
    expect(mainTrack(main)).toBe(main)
    expect(mainTrack([...main, { id: 's', parentToolUseId: 'task' }])).toEqual(main)
  })
})
