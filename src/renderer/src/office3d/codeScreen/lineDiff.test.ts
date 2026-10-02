import { describe, expect, it } from 'vitest'
import { diffLines, type DiffOp } from './lineDiff'

/** O diff como texto: ' ' igual, '-' removida, '+' adicionada. */
function show(a: string, b: string): string {
  const A = a === '' ? [] : a.split('\n')
  const B = b === '' ? [] : b.split('\n')
  return diffLines(A, B)
    .map((o) => (o.op === 'eq' ? ` ${A[o.a!]}` : o.op === 'del' ? `-${A[o.a!]}` : `+${B[o.b!]}`))
    .join('|')
}

describe('diffLines (LCS por linha)', () => {
  it('textos iguais: tudo igual', () => {
    expect(show('a\nb', 'a\nb')).toBe(' a| b')
  })

  it('troca no meio: só a linha mudada, a removida antes da adicionada', () => {
    expect(show('a\nb\nc\nd', 'a\nB\nc\nd')).toBe(' a|-b|+B| c| d')
  })

  it('inserção e remoção puras', () => {
    expect(show('a\nc', 'a\nb\nc')).toBe(' a|+b| c')
    expect(show('a\nb\nc', 'a\nc')).toBe(' a|-b| c')
  })

  it('subsequência comum de verdade, não só prefixo e sufixo', () => {
    expect(show('x\na\ny\nb\nz', 'a\nq\nb')).toBe('-x| a|-y|+q| b|-z')
  })

  it('vazio de um lado: tudo adicionado ou tudo removido', () => {
    expect(show('', 'a\nb')).toBe('+a|+b')
    expect(show('a\nb', '')).toBe('-a|-b')
  })

  it('índices a/b apontam as linhas de cada lado', () => {
    const ops: DiffOp[] = diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])
    expect(ops).toEqual([
      { op: 'eq', a: 0, b: 0 },
      { op: 'del', a: 1 },
      { op: 'add', b: 1 },
      { op: 'eq', a: 2, b: 2 }
    ])
  })

  it('arquivo grande mudado nas duas pontas e no meio: só as linhas mudadas (âncoras únicas)', () => {
    const a = Array.from({ length: 6000 }, (_, i) => `linha ${i}`)
    const b = [...a]
    b[0] = 'nova 0'
    b[5999] = 'nova fim'
    b.splice(3000, 0, 'inserida')
    const ops = diffLines(a, b)
    expect(ops.filter((o) => o.op === 'add')).toHaveLength(3)
    expect(ops.filter((o) => o.op === 'del')).toHaveLength(2)
    expect(ops.filter((o) => o.op === 'eq')).toHaveLength(5998)
  })

  it('grande e sem nada em comum: bloco removido + bloco adicionado, sem travar', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i % 7}`)
    const b = Array.from({ length: 3000 }, (_, i) => `b${i % 5}`)
    const t = performance.now()
    const ops = diffLines(a, b)
    expect(performance.now() - t).toBeLessThan(1500)
    expect(ops.filter((o) => o.op === 'del')).toHaveLength(3000)
    expect(ops.filter((o) => o.op === 'add')).toHaveLength(3000)
  })
})
