import { describe, expect, it } from 'vitest'
import { OfficeState } from '../engine/officeState'
import { CharacterState } from '../engine/types'
import { LOOK, ROOM_A, inRect, runUntil, twoRoomLayout } from '../engine/testFixtures'
import { SLEEP_AFTER_SEC, SWITCH_MAX_SEC, installLeisure, type LeisureMode } from './leisure'

/** RNG fixo que repete a sequência dada. */
function seq(values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length]
}

/** Escritório mínimo com um principal já sentado e parado. */
function setup(rng: () => number) {
  const state = new OfficeState(twoRoomLayout())
  const leisure = installLeisure(state, { rng })
  state.addAgent(1, { roomId: 'A', look: LOOK, seatKind: 'principal' })
  const ch = state.getCharacter(1)!
  runUntil(state, () => ch.state === CharacterState.TYPE && ch.tileCol === 3 && ch.tileRow === 3)
  state.setAgentActive(1, false)
  return { state, leisure, ch }
}

/** Avança `sec` segundos de jogo com dt sintético, anotando os modos vistos. */
function advance(state: OfficeState, sec: number, seen?: Set<LeisureMode | null>, modeOf?: () => LeisureMode | null) {
  const dt = 0.1
  for (let t = 0; t < sec; t += dt) {
    state.update(dt)
    if (seen && modeOf) seen.add(modeOf())
  }
}

describe('lazer do agente parado', () => {
  it('alterna celular, perambular e mesa com RNG fixo, trocando em 2–5 min', () => {
    // Pares (modo, duração): 0.1→celular, 0.5→perambular, 0.9→mesa; duração 0 = 2 min.
    const { state, leisure, ch } = setup(seq([0.1, 0, 0.5, 0, 0.9, 0]))
    const seen = new Set<LeisureMode | null>()
    advance(state, 1)
    expect(leisure.modeOf(1)).toBe('celular')
    expect(ch.prop).toBe('celular')
    advance(state, SWITCH_MAX_SEC + 30, seen, () => leisure.modeOf(1))
    expect(seen.has('perambular')).toBe(true)
    expect(seen.has('mesa')).toBe(true)
    // Perambular fica na sala.
    expect(inRect(ch, ROOM_A)).toBe(true)
  })

  it('mesa: senta no assento sem prop', () => {
    const { state, leisure, ch } = setup(seq([0.9, 0.99]))
    advance(state, 30)
    expect(leisure.modeOf(1)).toBe('mesa')
    expect(ch.prop).toBeNull()
    expect(ch.state).toBe(CharacterState.TYPE)
    expect([ch.tileCol, ch.tileRow]).toEqual([3, 3])
  })

  it('dorme só depois de 10 min parado, sentado e com zzz', () => {
    const { state, leisure, ch } = setup(seq([0.5, 0]))
    advance(state, SLEEP_AFTER_SEC - 5)
    expect(ch.prop).not.toBe('zzz')
    expect(leisure.modeOf(1)).not.toBe('dormir')
    advance(state, 60)
    expect(leisure.modeOf(1)).toBe('dormir')
    expect(ch.prop).toBe('zzz')
    expect(ch.state).toBe(CharacterState.TYPE)
    expect([ch.tileCol, ch.tileRow]).toEqual([3, 3])
  })

  it('wake tira o zzz na hora e zera idleSince', () => {
    const { state, leisure, ch } = setup(seq([0.5, 0]))
    advance(state, SLEEP_AFTER_SEC + 60)
    expect(ch.prop).toBe('zzz')
    leisure.wake(ch)
    expect(ch.prop).toBeNull()
    expect(ch.idleSince).toBe(0)
    expect(leisure.modeOf(1)).toBeNull()
    state.setAgentActive(1, true)
    advance(state, 1)
    expect(ch.prop).toBeNull()
  })

  it('ativo nunca entra em lazer', () => {
    const state = new OfficeState(twoRoomLayout())
    const leisure = installLeisure(state, { rng: seq([0.1, 0]) })
    state.addAgent(1, { roomId: 'A', look: LOOK, seatKind: 'principal' })
    const ch = state.getCharacter(1)!
    expect(leisure.idleBehavior(ch, 0.1, state)).toBe(false)
    advance(state, SLEEP_AFTER_SEC + 60)
    expect(leisure.modeOf(1)).toBeNull()
    expect(ch.prop).toBeNull()
  })

  it('balão de permissão ou pergunta tira do lazer e o gancho devolve false', () => {
    const { state, leisure, ch } = setup(seq([0.1, 0]))
    advance(state, 1)
    expect(ch.prop).toBe('celular')
    state.showBubble(1, 'pergunta')
    expect(leisure.idleBehavior(ch, 0.1, state)).toBe(false)
    expect(ch.prop).toBeNull()
    expect(leisure.modeOf(1)).toBeNull()
  })

  it('subagente não faz lazer', () => {
    const { state, leisure } = setup(seq([0.1, 0]))
    const subId = state.addSubagent(1, 'tool-1', LOOK)
    const sub = state.getCharacter(subId)!
    sub.isActive = false
    expect(leisure.idleBehavior(sub, 0.1, state)).toBe(false)
    expect(leisure.modeOf(subId)).toBeNull()
  })
})
