// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { forgetUsedMemories, recordUsedMemories, usedMemories } from './memoriasUsadas'

beforeEach(() => {
  forgetUsedMemories('c1')
  forgetUsedMemories('c2')
})

describe('registro das memórias usadas no turno', () => {
  it('cada turno SUBSTITUI a lista da sua conversa', () => {
    recordUsedMemories('c1', ['erp.md'])
    recordUsedMemories('c1', ['nota.md', '2D/fiscal.md'])

    // Acumular faria o gate ver memória que não está no prompt deste turno.
    expect(usedMemories('c1')).toEqual(['nota.md', '2D/fiscal.md'])
  })

  it('conversas não se misturam', () => {
    recordUsedMemories('c1', ['erp.md'])
    recordUsedMemories('c2', ['nota.md'])

    expect(usedMemories('c1')).toEqual(['erp.md'])
    expect(usedMemories('c2')).toEqual(['nota.md'])
  })

  it('turno sem memória alguma grava lista vazia, sem lançar', () => {
    recordUsedMemories('c1', ['erp.md'])

    expect(() => recordUsedMemories('c1', [])).not.toThrow()
    expect(usedMemories('c1')).toEqual([])
  })

  it('descarta caminho vazio ou repetido — e ignora conversa sem id', () => {
    recordUsedMemories('c1', ['erp.md', 'erp.md', '   ', ''])
    expect(usedMemories('c1')).toEqual(['erp.md'])

    expect(() => recordUsedMemories('', ['erp.md'])).not.toThrow()
    expect(usedMemories('')).toEqual([])
  })

  it('não cresce sem limite: a lista é cortada no teto', () => {
    recordUsedMemories('c1', Array.from({ length: 40 }, (_, i) => `m${i}.md`))

    expect(usedMemories('c1')).toHaveLength(16)
    expect(usedMemories('c1')[0]).toBe('m0.md')
  })

  it('esquecer a conversa apaga a entrada', () => {
    recordUsedMemories('c1', ['erp.md'])
    forgetUsedMemories('c1')

    expect(usedMemories('c1')).toEqual([])
  })

  it('conversa que ninguém registrou devolve vazio, não undefined', () => {
    expect(usedMemories('nunca-vista')).toEqual([])
  })
})
