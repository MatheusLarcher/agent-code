import { describe, expect, it, vi } from 'vitest'
import { characterPose } from './characters'
import type { IdleBehavior } from './officeState'
import { LOOK, ROOM_A, inRect, newOffice, runUntil, twoRoomLayout } from './testFixtures'
import { CharacterState, Direction } from './types'

describe('addAgent', () => {
  it('nasce na porta da sala e anda até o assento livre dela', () => {
    const office = newOffice()
    office.addAgent(1, { roomId: 'A', look: LOOK, label: 'principal' })
    const ch = office.getCharacter(1)!
    expect({ col: ch.tileCol, row: ch.tileRow }).toEqual({ col: ROOM_A.doorCol, row: ROOM_A.doorRow })
    expect(ch.state).toBe(CharacterState.WALK)
    expect(ch.seatId).toBe('A1')
    expect(ch.label).toBe('principal')
    expect(office.seats.get('A1')!.assigned).toBe(true)

    expect(runUntil(office, () => ch.state === CharacterState.TYPE)).toBe(true)
    expect({ col: ch.tileCol, row: ch.tileRow }).toEqual({ col: 3, row: 3 })
    expect(ch.dir).toBe(Direction.UP)
    expect(characterPose(ch).pose).toBe('sitType')
  })

  it('salas separadas não compartilham assento', () => {
    const office = newOffice()
    office.addAgent(1, { roomId: 'A', look: LOOK })
    office.addAgent(2, { roomId: 'B', look: LOOK })
    // B só tem um assento: o terceiro fica sem, mesmo com A2 livre e até pedindo A2.
    office.addAgent(3, { roomId: 'B', look: LOOK })
    office.addAgent(4, { roomId: 'B', look: LOOK, preferredSeatId: 'A2' })
    expect(office.getCharacter(1)!.seatId).toBe('A1')
    expect(office.getCharacter(2)!.seatId).toBe('B1')
    expect(office.getCharacter(3)!.seatId).toBeNull()
    expect(office.getCharacter(4)!.seatId).toBeNull()
    expect(office.seats.get('A2')!.assigned).toBe(false)
  })

  it('vaga nomeada (slot) e tipo explícito escolhem o assento certo', () => {
    const office = newOffice()
    office.addAgent(5, { roomId: 'A', look: LOOK, slot: 'executor' })
    expect(office.getCharacter(5)!.seatId).toBe('A2')
    // Tipo explícito sem vaga daquele tipo: não toma a cadeira do principal.
    office.addAgent(6, { roomId: 'A', look: LOOK, seatKind: 'especialista' })
    expect(office.getCharacter(6)!.seatId).toBeNull()
    expect(office.seats.get('A1')!.assigned).toBe(false)
  })

  it('id repetido não duplica o personagem', () => {
    const office = newOffice()
    office.addAgent(1, { roomId: 'A', look: LOOK })
    office.addAgent(1, { roomId: 'B', look: LOOK })
    expect(office.getCharacters()).toHaveLength(1)
    expect(office.getCharacter(1)!.roomId).toBe('A')
  })
})

describe('removeAgent', () => {
  it('libera o assento na hora, anda até a porta e só some ao chegar', () => {
    const office = newOffice()
    office.addAgent(1, { roomId: 'A', look: LOOK })
    const ch = office.getCharacter(1)!
    runUntil(office, () => ch.state === CharacterState.TYPE)
    office.selectedAgentId = 1

    office.removeAgent(1)
    expect(office.seats.get('A1')!.assigned).toBe(false)
    expect(ch.leaving).toBe(true)
    expect(office.getCharacter(1)).toBe(ch)
    expect(office.getCharacterAt(ch.x, ch.y)).toBeNull()

    let last = { col: ch.tileCol, row: ch.tileRow }
    let ticks = 0
    while (office.getCharacter(1) && ticks < 2000) {
      last = { col: ch.tileCol, row: ch.tileRow }
      office.update(0.05)
      ticks++
    }
    expect(office.getCharacter(1)).toBeUndefined()
    expect(ticks).toBeGreaterThan(10)
    expect(last).toEqual({ col: ROOM_A.doorCol, row: ROOM_A.doorRow })
    expect(office.selectedAgentId).toBeNull()
  })

  it('o assento liberado já serve para quem chega', () => {
    const office = newOffice()
    office.addAgent(1, { roomId: 'B', look: LOOK })
    office.removeAgent(1)
    office.addAgent(2, { roomId: 'B', look: LOOK })
    expect(office.getCharacter(2)!.seatId).toBe('B1')
  })
})

describe('subagentes', () => {
  it('id negativo e estável; removeSubagent limpa personagem e mapas', () => {
    const office = newOffice()
    office.addAgent(1, { roomId: 'A', look: LOOK })
    const parent = office.getCharacter(1)!
    runUntil(office, () => parent.state === CharacterState.TYPE)

    const sid = office.addSubagent(1, 'tool-1', LOOK)
    expect(sid).toBeLessThan(0)
    expect(office.addSubagent(1, 'tool-1', LOOK)).toBe(sid)
    expect(office.getSubagentId(1, 'tool-1')).toBe(sid)
    const sid2 = office.addSubagent(1, 'tool-2', LOOK)
    expect(sid2).toBeLessThan(0)
    expect(sid2).not.toBe(sid)

    const sub = office.getCharacter(sid)!
    expect(sub.isSubagent).toBe(true)
    expect(sub.parentAgentId).toBe(1)
    expect(sub.roomId).toBe('A')
    expect(inRect(sub, ROOM_A)).toBe(true)
    expect({ col: sub.tileCol, row: sub.tileRow }).not.toEqual({ col: parent.tileCol, row: parent.tileRow })

    office.removeSubagent(1, 'tool-1')
    expect(office.getCharacter(sid)).toBeUndefined()
    expect(office.getSubagentId(1, 'tool-1')).toBeNull()

    office.removeAllSubagents(1)
    expect(office.getCharacter(sid2)).toBeUndefined()
    expect(office.getSubagentId(1, 'tool-2')).toBeNull()
    // Um id nunca é reaproveitado.
    const again = office.addSubagent(1, 'tool-1', LOOK)
    expect(again).not.toBe(sid)
    expect(again).not.toBe(sid2)
  })
})

describe('walkToDestination', () => {
  it('destino ausente na sala devolve false sem mexer no personagem', () => {
    const office = newOffice()
    office.addAgent(2, { roomId: 'B', look: LOOK })
    const ch = office.getCharacter(2)!
    const before = ch.path.map((p) => ({ ...p }))
    expect(office.walkToDestination(2, 'kanban')).toBe(false)
    expect(office.walkToDestination(2, 'impressora')).toBe(false)
    expect(ch.path).toEqual(before)
    expect(office.walkToDestination(99, 'copa')).toBe(false)
  })

  it('anda até o destino da sala (vizinho andável quando o ponto é parede) e ao destino comum', () => {
    const office = newOffice()
    office.addAgent(1, { roomId: 'A', look: LOOK })
    const ch = office.getCharacter(1)!
    runUntil(office, () => ch.state === CharacterState.TYPE)
    expect(office.walkToDestination(1, 'kanban')).toBe(true)
    expect(runUntil(office, () => ch.tileCol === 5 && ch.tileRow === 1)).toBe(true)

    office.addAgent(2, { roomId: 'B', look: LOOK })
    const b = office.getCharacter(2)!
    expect(office.walkToDestination(2, 'copa')).toBe(true)
    expect(runUntil(office, () => b.tileCol === 10 && b.tileRow === 10)).toBe(true)
  })
})

describe('ocioso', () => {
  it('perambula só dentro da própria sala', () => {
    const office = newOffice()
    office.addAgent(1, { roomId: 'A', look: LOOK })
    const ch = office.getCharacter(1)!
    runUntil(office, () => ch.state === CharacterState.TYPE)
    office.setAgentActive(1, false)
    const seen = new Set<string>()
    for (let i = 0; i < 3000; i++) {
      office.update(0.1)
      expect(inRect(ch, ROOM_A)).toBe(true)
      seen.add(`${ch.tileCol},${ch.tileRow}`)
    }
    expect(seen.size).toBeGreaterThan(1)
    expect(ch.idleSince).toBeGreaterThan(299)
  })

  it('idleBehavior que devolve true substitui o perambular', () => {
    const office = newOffice()
    office.addAgent(1, { roomId: 'A', look: LOOK })
    const ch = office.getCharacter(1)!
    runUntil(office, () => ch.state === CharacterState.TYPE)
    const hook = vi.fn<IdleBehavior>(() => true)
    office.idleBehavior = hook
    office.setAgentActive(1, false)
    for (let i = 0; i < 600; i++) office.update(0.1)
    expect(hook).toHaveBeenCalled()
    expect(hook.mock.calls[0][2]).toBe(office)
    expect(ch.state).toBe(CharacterState.TYPE)
    expect({ col: ch.tileCol, row: ch.tileRow }).toEqual({ col: 3, row: 3 })
    expect(characterPose(ch).pose).toBe('sit')

    office.setAgentActive(1, true)
    expect(ch.idleSince).toBe(0)
  })
})

describe('balões, objetos e layout', () => {
  it('ok some sozinho; permissão fica até limpar; clearBubble com kind respeita o tipo', () => {
    const office = newOffice()
    office.addAgent(1, { roomId: 'A', look: LOOK })
    const ch = office.getCharacter(1)!
    office.showBubble(1, 'ok')
    runUntil(office, () => false, 3)
    expect(ch.bubble).toBeNull()

    office.showBubble(1, 'permissao')
    runUntil(office, () => false, 10)
    expect(ch.bubble).toBe('permissao')
    office.clearBubble(1, 'pergunta')
    expect(ch.bubble).toBe('permissao')
    office.clearBubble(1)
    expect(ch.bubble).toBeNull()

    office.setProp(1, 'lupa')
    expect(ch.prop).toBe('lupa')
  })

  it('rebuildFromLayout preserva o assento de quem já está sentado', () => {
    const office = newOffice()
    office.addAgent(1, { roomId: 'A', look: LOOK })
    const ch = office.getCharacter(1)!
    runUntil(office, () => ch.state === CharacterState.TYPE)
    const version = office.layoutVersion
    office.rebuildFromLayout(twoRoomLayout())
    expect(office.layoutVersion).toBe(version + 1)
    expect(ch.seatId).toBe('A1')
    expect(office.seats.get('A1')!.assigned).toBe(true)
    expect(ch.state).toBe(CharacterState.TYPE)
    expect({ col: ch.tileCol, row: ch.tileRow }).toEqual({ col: 3, row: 3 })
  })

  it('layout com tiles faltando é recusado', () => {
    const bad = { ...twoRoomLayout(), tiles: [] }
    expect(() => newOffice().rebuildFromLayout(bad)).toThrow(/tiles/)
  })
})
