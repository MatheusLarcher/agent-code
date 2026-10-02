import { describe, expect, it } from 'vitest'
import type { ToolInputDelta } from '../../office/liveInput'
import { liveText, stitch, type LiveBlock } from './stitch'

const delta = (over: Partial<ToolInputDelta>): ToolInputDelta => ({
  kind: 'tool-input-delta',
  toolUseId: 'w1',
  name: 'Write',
  filePath: 'C:\\p\\a.ts',
  newText: '',
  totalLines: 0,
  done: false,
  ...over
})
/** Linhas "L<from+1>"…"L<to>" — o que o main manda como cauda. */
const tail = (from: number, to: number): string => Array.from({ length: to - from }, (_, i) => `L${from + i + 1}`).join('\n')
const all = (n: number): string[] => Array.from({ length: n }, (_, i) => `L${i + 1}`)

describe('stitch (caudas de 40 linhas do tool-input-delta)', () => {
  it('até 40 linhas a cauda é o texto inteiro', () => {
    const b = stitch(undefined, delta({ newText: tail(0, 3), totalLines: 3 }), 1)
    expect(b.lines).toEqual(all(3))
    expect(b).toMatchObject({ toolUseId: 'w1', name: 'Write', filePath: 'C:\\p\\a.ts', totalLines: 3, done: false, at: 1 })
  })

  it('caudas que se sobrepõem costuram sem duplicar nem perder', () => {
    let b: LiveBlock = stitch(undefined, delta({ newText: tail(0, 40), totalLines: 40 }), 1)
    b = stitch(b, delta({ newText: tail(5, 45), totalLines: 45 }), 2)
    b = stitch(b, delta({ newText: tail(30, 70), totalLines: 70 }), 3)
    expect(b.lines).toEqual(all(70))
  })

  it('buraco: as linhas nunca vistas ficam null (placeholder), as vistas ficam', () => {
    let b = stitch(undefined, delta({ newText: tail(0, 10), totalLines: 10 }), 1)
    b = stitch(b, delta({ newText: tail(60, 100), totalLines: 100 }), 2)
    expect(b.lines.slice(0, 10)).toEqual(all(10))
    expect(b.lines.slice(10, 60).every((l) => l === null)).toBe(true)
    expect(b.lines.slice(60)).toEqual(all(100).slice(60))
  })

  it('a última linha cresce a cada pedaço e é reescrita', () => {
    let b = stitch(undefined, delta({ newText: 'const a', totalLines: 1 }), 1)
    b = stitch(b, delta({ newText: 'const a = 1\nlet', totalLines: 2 }), 2)
    expect(b.lines).toEqual(['const a = 1', 'let'])
  })

  it('MultiEdit: item novo (texto antigo diferente ou menos linhas) recomeça do zero', () => {
    let b = stitch(undefined, delta({ name: 'MultiEdit', oldText: 'x', newText: tail(0, 5), totalLines: 5 }), 1)
    b = stitch(b, delta({ name: 'MultiEdit', oldText: 'y', newText: 'novo', totalLines: 1 }), 2)
    expect(b.lines).toEqual(['novo'])
    b = stitch(b, delta({ name: 'MultiEdit', oldText: 'y', newText: tail(0, 50), totalLines: 50 }), 3)
    b = stitch(b, delta({ name: 'MultiEdit', oldText: 'y', newText: 'z', totalLines: 1 }), 4)
    expect(b.lines).toEqual(['z'])
  })

  it('done marca o bloco e guarda o texto; o caminho que já veio não some', () => {
    let b = stitch(undefined, delta({ newText: 'a', totalLines: 1 }), 1)
    b = stitch(b, delta({ filePath: undefined, newText: 'a\nb', totalLines: 2, done: true }), 2)
    expect(b).toMatchObject({ done: true, filePath: 'C:\\p\\a.ts', lines: ['a', 'b'] })
  })

  it('liveText junta as linhas (buraco = linha vazia) e diz onde estão os buracos', () => {
    let b = stitch(undefined, delta({ newText: tail(0, 2), totalLines: 2 }), 1)
    b = stitch(b, delta({ newText: tail(42, 44), totalLines: 44 }), 2)
    // Só 2 linhas vistas da cauda nova: o main manda até 40, aqui a cauda tem 2 (o resto é buraco).
    const { text, gaps } = liveText(b)
    expect(text.split('\n')).toHaveLength(44)
    expect(gaps[0]).toBe(false)
    expect(gaps[2]).toBe(true)
    expect(gaps[43]).toBe(false)
  })
})
