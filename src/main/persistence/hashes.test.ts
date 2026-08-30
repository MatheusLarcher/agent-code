import { describe, expect, it } from 'vitest'
import { canonicalJson, hashAggregate, hashJson, hashText } from './hashes'

describe('hashes de persistência', () => {
  it('canonicaliza objetos sem alterar a ordem dos arrays', () => {
    expect(canonicalJson({ z: 1, a: { d: 2, c: [3, 1] } })).toBe('{"a":{"c":[3,1],"d":2},"z":1}')
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }))
    expect(hashJson([1, 2])).not.toBe(hashJson([2, 1]))
  })

  it('normaliza zero negativo e rejeita números que JSON não preserva', () => {
    expect(canonicalJson(-0)).toBe('0')
    expect(() => canonicalJson(Number.NaN)).toThrow('números não finitos')
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow('números não finitos')
  })

  it('separa texto cru de string JSON', () => {
    expect(hashText('valor')).not.toBe(hashJson('valor'))
  })

  it('calcula hash agregado independente da ordem de leitura', () => {
    const first = [
      { entity: 'conversation', id: 'b', contentHash: '2' },
      { entity: 'kv', id: 'a', contentHash: '1' }
    ]
    expect(hashAggregate(first)).toBe(hashAggregate([...first].reverse()))
    expect(hashAggregate(first)).not.toBe(hashAggregate([{ ...first[0], id: 'c' }, first[1]]))
  })
})
