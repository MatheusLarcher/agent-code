import { describe, expect, it, vi } from 'vitest'
import { createGameLoop } from './gameLoop'
import { LOOK, newOffice } from './testFixtures'

// Regressões dos 4 bugs que o crítico reproduziu na revisão 7.

describe('regressão 1: readd em outra sala durante a saída', () => {
  it('passa para a sala nova junto com o assento dela', () => {
    const office = newOffice()
    office.addAgent(1, { roomId: 'A', look: LOOK })
    office.removeAgent(1)
    office.addAgent(1, { roomId: 'B', look: LOOK })
    const ch = office.getCharacter(1)!
    expect(ch.leaving).toBe(false)
    expect(ch.roomId).toBe('B')
    expect(ch.seatId).toBe('B1')
    expect(office.seats.get('B1')!.roomId).toBe(ch.roomId)
    expect(office.seats.get('A1')!.assigned).toBe(false)
  })
})

describe('regressão 2: removeAgent num subagente', () => {
  it('limpa o registro: getSubagentId some e addSubagent cria personagem de verdade', () => {
    const office = newOffice()
    office.addAgent(1, { roomId: 'A', look: LOOK })
    const sub = office.addSubagent(1, 't', LOOK)
    office.removeAgent(sub)
    expect(office.getCharacter(sub)).toBeUndefined()
    expect(office.getSubagentId(1, 't')).toBeNull()
    const again = office.addSubagent(1, 't', LOOK)
    expect(office.getCharacter(again)).toBeDefined()
    expect(again).toBeLessThan(0)
  })
})

describe('regressão 3: stop()+start() dentro do quadro', () => {
  function fakeRaf() {
    const pending = new Map<number, FrameRequestCallback>()
    let next = 1
    return {
      raf: (cb: FrameRequestCallback) => {
        const id = next++
        pending.set(id, cb)
        return id
      },
      caf: (id: number) => void pending.delete(id),
      tickAll(time: number) {
        const cbs = [...pending.values()]
        pending.clear()
        for (const cb of cbs) cb(time)
      },
      pending
    }
  }

  for (const where of ['update', 'render'] as const) {
    it(`em ${where}: um rAF só, e nenhum depois de stop`, () => {
      const f = fakeRaf()
      let restart = true
      const update = vi.fn()
      const cbs = { update, render: () => {} }
      const loop = createGameLoop(
        {
          update: (dt) => {
            update(dt)
            if (where === 'update' && restart) {
              restart = false
              loop.stop()
              loop.start()
            }
          },
          render: () => {
            cbs.render()
            if (where === 'render' && restart) {
              restart = false
              loop.stop()
              loop.start()
            }
          }
        },
        f.raf,
        f.caf
      )
      loop.start()
      f.tickAll(10)
      expect(f.pending.size).toBe(1)
      f.tickAll(26)
      expect(update).toHaveBeenCalledTimes(2)
      expect(f.pending.size).toBe(1)
      loop.stop()
      expect(f.pending.size).toBe(0)
    })
  }

  it('stop() dentro do quadro não reagenda', () => {
    const f = fakeRaf()
    const loop = createGameLoop({ update: () => loop.stop(), render: () => {} }, f.raf, f.caf)
    loop.start()
    f.tickAll(10)
    expect(f.pending.size).toBe(0)
    expect(loop.running).toBe(false)
  })
})

describe('regressão 4: addAgent com id inválido', () => {
  it.each([0, -1, 1.5, Number.NaN])('lança RangeError para id %s e não cria personagem', (id) => {
    const office = newOffice()
    expect(() => office.addAgent(id, { roomId: 'A', look: LOOK })).toThrow(RangeError)
    expect(office.getCharacters()).toHaveLength(0)
  })

  it('id de subagente não colide com agente', () => {
    const office = newOffice()
    office.addAgent(1, { roomId: 'A', look: LOOK })
    const sub = office.addSubagent(1, 't', LOOK)
    expect(() => office.addAgent(sub, { roomId: 'A', look: LOOK })).toThrow(RangeError)
    expect(office.getCharacter(sub)!.isSubagent).toBe(true)
  })
})
