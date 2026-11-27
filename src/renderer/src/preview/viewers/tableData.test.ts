import { describe, expect, it } from 'vitest'
import {
  columnNumberFormat,
  filterIndices,
  nextSort,
  pageCount,
  parseNumber,
  searchIndex,
  sortIndices
} from './tableData'

describe('parseNumber', () => {
  it('lê pt-BR e en', () => {
    expect(parseNumber('1.234,56', 'pt')).toBe(1234.56)
    expect(parseNumber('R$ 1.234,56', 'pt')).toBe(1234.56)
    expect(parseNumber('-12', 'pt')).toBe(-12)
    expect(parseNumber('1,234.56', 'en')).toBe(1234.56)
    expect(parseNumber('45%', 'en')).toBe(45)
    expect(parseNumber('abc', 'pt')).toBeNaN()
    expect(parseNumber('1,234.56', 'pt')).toBeNaN()
  })
})

describe('columnNumberFormat', () => {
  it('coluna toda numérica, ignorando vazias; pt-BR vence no empate', () => {
    expect(columnNumberFormat([['1.234,5'], [''], ['10']], 0)).toBe('pt')
    expect(columnNumberFormat([['1,234.5'], ['10']], 0)).toBe('en')
    expect(columnNumberFormat([['1.234'], ['12']], 0)).toBe('pt')
    expect(columnNumberFormat([['10'], ['dez']], 0)).toBeNull()
    expect(columnNumberFormat([[''], ['']], 0)).toBeNull()
  })

  it("modo 'dot' (JSON) lê 1.5 como um e meio", () => {
    expect(columnNumberFormat([['1.5'], ['2']], 0, 'dot')).toBe('en')
  })
})

describe('nextSort', () => {
  it('crescente → decrescente → sem ordem; outra coluna recomeça', () => {
    const a = nextSort(null, 1)
    expect(a).toEqual({ col: 1, dir: 'asc' })
    const b = nextSort(a, 1)
    expect(b).toEqual({ col: 1, dir: 'desc' })
    expect(nextSort(b, 1)).toBeNull()
    expect(nextSort(b, 2)).toEqual({ col: 2, dir: 'asc' })
  })
})

describe('sortIndices', () => {
  const rows = [['10'], ['9'], [''], ['1.000,5'], ['100']]
  const all = rows.map((_, i) => i)

  it('numérico compara como número, vazio no fim', () => {
    expect(sortIndices(rows, all, { col: 0, dir: 'asc' }, 'pt')).toEqual([1, 0, 4, 3, 2])
    expect(sortIndices(rows, all, { col: 0, dir: 'desc' }, 'pt')).toEqual([3, 4, 0, 1, 2])
  })

  it('texto em pt-BR sem diferenciar acento e maiúscula', () => {
    const t = [['banana'], ['Ábaco'], ['caju'], ['abacate']]
    expect(sortIndices(t, [0, 1, 2, 3], { col: 0, dir: 'asc' }, null)).toEqual([3, 1, 0, 2])
  })

  it('sem ordem devolve como veio', () => {
    expect(sortIndices(rows, all, null, 'pt')).toBe(all)
  })
})

describe('filtro e páginas', () => {
  it('acha sem acento, em qualquer coluna, sem juntar células vizinhas', () => {
    const idx = searchIndex([
      ['Ação', 'x'],
      ['casa', 'Pão'],
      ['ab', 'c']
    ])
    expect(filterIndices(idx, 'acao')).toEqual([0])
    expect(filterIndices(idx, 'PAO')).toEqual([1])
    expect(filterIndices(idx, 'bc')).toEqual([])
    expect(filterIndices(idx, '  ')).toEqual([0, 1, 2])
  })

  it('pageCount', () => {
    expect(pageCount(0)).toBe(1)
    expect(pageCount(100)).toBe(1)
    expect(pageCount(101)).toBe(2)
  })
})
