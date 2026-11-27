import { describe, expect, it } from 'vitest'
import { markNumbers } from './overlay'

describe('markNumbers (número da marca no sync)', () => {
  it('com número: usa o "[elemento N]" que veio do campo', () => {
    expect([...markNumbers([{ selector: '#a', n: 3 }, { selector: '#b', n: 5 }])]).toEqual([
      ['#a', 3],
      ['#b', 5]
    ])
  })

  it('lista só de seletores (formato antigo): numera pela posição', () => {
    expect([...markNumbers(['#a', '#b'])]).toEqual([
      ['#a', 1],
      ['#b', 2]
    ])
  })

  it('entrada inválida é ignorada; número ruim cai na posição; repetido fica com o primeiro', () => {
    expect(markNumbers(null).size).toBe(0)
    expect(markNumbers('x').size).toBe(0)
    expect([...markNumbers([{ n: 2 }, 7, { selector: '#a', n: 0 }, { selector: '#a', n: 9 }, { selector: '#b', n: 1.5 }])]).toEqual([
      ['#a', 3],
      ['#b', 5]
    ])
  })
})
