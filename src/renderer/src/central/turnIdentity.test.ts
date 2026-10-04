import { describe, expect, it } from 'vitest'
import { createTurnIdentity, withStaleUsage, type TurnInflight } from './turnIdentity'

/** De quem é cada evento do main, pelos `turnIds` (puro). */

describe('createTurnIdentity — de quem é o evento', () => {
  it('sem id (main/CLI antigo, evento da sessão): unknown — decide o caminho de sempre', () => {
    const t = createTurnIdentity()
    expect(t.owner('a', undefined, { sdkUuid: 'S' })).toBe('unknown')
    expect(t.owner('a', [], { sdkUuid: 'S' })).toBe('unknown')
  })

  it('o id do turno em voo: current', () => {
    const t = createTurnIdentity()
    expect(t.owner('a', ['S'], { sdkUuid: 'S' })).toBe('current')
  })

  it('o turno parado, sem outro em voo: stopped (é o fim dele)', () => {
    const t = createTurnIdentity()
    const s: TurnInflight = { sdkUuid: 'S' }
    t.stop('a', s)
    expect(t.owner('a', ['S'], s)).toBe('stopped')
    expect(t.owner('a', ['S'], undefined)).toBe('stopped')
  })

  it('o turno parado com o seguinte em voo: stale — nunca é do seguinte', () => {
    const t = createTurnIdentity()
    t.stop('a', { sdkUuid: 'S' })
    expect(t.owner('a', ['S'], { sdkUuid: 'N' })).toBe('stale')
  })

  it('o CLI juntou a parada e a nova num turno só: é da nova (nada engolido)', () => {
    const t = createTurnIdentity()
    t.stop('a', { sdkUuid: 'S' })
    expect(t.owner('a', ['S', 'N'], { sdkUuid: 'N' })).toBe('current')
  })

  it('id desconhecido com um turno em voo vira dele (continuação da troca de provedor); parado depois, o id também', () => {
    const t = createTurnIdentity()
    const s: TurnInflight = { sdkUuid: 'S' }
    expect(t.owner('a', ['R'], s)).toBe('current')
    expect(s.turnIds).toEqual(['R'])
    t.stop('a', s)
    expect(t.owner('a', ['R'], { sdkUuid: 'N' })).toBe('stale')
  })

  it('id desconhecido com o turno em voo já parado: é do turno parado', () => {
    const t = createTurnIdentity()
    const s: TurnInflight = { sdkUuid: 'S' }
    t.stop('a', s)
    expect(t.owner('a', ['R'], s)).toBe('stopped')
    expect(t.owner('a', ['R'], { sdkUuid: 'N' })).toBe('stale')
  })

  it('id desconhecido sem turno em voo: unknown', () => {
    expect(createTurnIdentity().owner('a', ['X'], undefined)).toBe('unknown')
  })

  it('conversas não se misturam; forget esquece os parados', () => {
    const t = createTurnIdentity()
    t.stop('a', { sdkUuid: 'S' })
    expect(t.owner('b', ['S'], undefined)).toBe('unknown')
    expect(t.owner('a', ['S'], undefined)).toBe('stopped')
    t.forget('a')
    expect(t.owner('a', ['S'], undefined)).toBe('unknown')
  })
})

describe('withStaleUsage — o gasto do result descartado', () => {
  const conv = { id: 'a', tokens: { context: 900, output: 10, cost: 1, lastOutput: 4, lastCost: 0.5 } }

  it('soma saída e custo no total; contexto e "último turno" ficam', () => {
    expect(withStaleUsage(conv, { usage: { output: 7 }, costUsd: 0.25 }).tokens).toEqual({
      context: 900,
      output: 17,
      cost: 1.25,
      lastOutput: 4,
      lastCost: 0.5
    })
  })

  it('sem gasto: a mesma conversa', () => {
    expect(withStaleUsage(conv, {})).toBe(conv)
  })
})
