import { describe, it, expect } from 'vitest'
import {
  isArchived,
  partitionArchived,
  setArchived,
  firstVisibleId,
  nextActiveAfterArchive
} from '@shared/archive'

/** Testes de aceitação do benchmark — NÃO são vistos por quem implementa. */

interface C {
  id: string
  updatedAt: number
  archived?: boolean
}

const c = (id: string, archived?: boolean): C => ({ id, updatedAt: 1, ...(archived === undefined ? {} : { archived }) })

describe('archive — isArchived', () => {
  it('só é verdadeiro quando archived === true', () => {
    expect(isArchived(c('a', true))).toBe(true)
    expect(isArchived(c('a', false))).toBe(false)
    expect(isArchived(c('a'))).toBe(false)
  })
})

describe('archive — partitionArchived', () => {
  it('separa preservando a ordem das duas listas', () => {
    const list = [c('a'), c('b', true), c('c'), c('d', true)]
    const { visible, archived } = partitionArchived(list)
    expect(visible.map((x) => x.id)).toEqual(['a', 'c'])
    expect(archived.map((x) => x.id)).toEqual(['b', 'd'])
  })

  it('lista vazia devolve as duas vazias', () => {
    const { visible, archived } = partitionArchived([] as C[])
    expect(visible).toEqual([])
    expect(archived).toEqual([])
  })
})

describe('archive — setArchived', () => {
  it('marca só o item pedido', () => {
    const list = [c('a'), c('b')]
    const next = setArchived(list, 'b', true)
    expect(next.find((x) => x.id === 'b')?.archived).toBe(true)
    expect(isArchived(next.find((x) => x.id === 'a')!)).toBe(false)
  })

  it('desarquiva', () => {
    const next = setArchived([c('a', true)], 'a', false)
    expect(isArchived(next[0])).toBe(false)
  })

  it('não muta a lista nem os objetos originais', () => {
    const original = [c('a'), c('b')]
    const snapshot = JSON.stringify(original)
    setArchived(original, 'a', true)
    expect(JSON.stringify(original)).toBe(snapshot)
  })

  it('id inexistente não quebra nem altera nada', () => {
    const list = [c('a')]
    const next = setArchived(list, 'zzz', true)
    expect(next.map((x) => x.id)).toEqual(['a'])
    expect(isArchived(next[0])).toBe(false)
  })
})

describe('archive — firstVisibleId', () => {
  it('devolve a primeira não arquivada', () => {
    expect(firstVisibleId([c('a', true), c('b'), c('c')])).toBe('b')
  })

  it('devolve null quando todas estão arquivadas', () => {
    expect(firstVisibleId([c('a', true)])).toBe(null)
  })

  it('devolve null na lista vazia', () => {
    expect(firstVisibleId([] as C[])).toBe(null)
  })
})

describe('archive — nextActiveAfterArchive', () => {
  it('pega a próxima não arquivada depois do item', () => {
    expect(nextActiveAfterArchive([c('a'), c('b'), c('c')], 'b')).toBe('c')
  })

  it('pula as arquivadas que vêm depois', () => {
    expect(nextActiveAfterArchive([c('a'), c('b'), c('c', true), c('d')], 'b')).toBe('d')
  })

  it('cai para a anterior quando não há nenhuma depois', () => {
    expect(nextActiveAfterArchive([c('a'), c('b'), c('c')], 'c')).toBe('b')
  })

  it('devolve null quando não sobra nenhuma visível', () => {
    expect(nextActiveAfterArchive([c('a')], 'a')).toBe(null)
    expect(nextActiveAfterArchive([c('a', true), c('b')], 'b')).toBe(null)
  })

  it('id inexistente devolve null', () => {
    expect(nextActiveAfterArchive([c('a')], 'zzz')).toBe(null)
  })
})
