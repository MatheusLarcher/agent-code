import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { memorySavedLabel, savedMemories } from './memorySaved'
import { MemorySavedNote } from './MemorySavedNote'

const ok = { isError: false, text: 'ok' }
const propose = (input: Record<string, unknown>, result: unknown = ok) => ({ kind: 'tool-use', name: 'mcp__memory__memory_propose', input, result })

describe('savedMemories', () => {
  it('só memory_propose com sucesso; a última operação da mesma memória vence', () => {
    const list = savedMemories([
      propose({ op: 'create', rel_path: 'a.md', title: 'A' }),
      propose({ op: 'create', rel_path: 'b.md', title: 'B' }, { isError: true, text: 'falhou' }),
      propose({ op: 'create', rel_path: 'c.md' }, null),
      { kind: 'tool-use', name: 'mcp__memory__memory_list', input: {}, result: ok },
      propose({ op: 'update', rel_path: 'a.md', title: 'A2' }),
      propose({ op: 'retire', rel_path: 'pasta\\velha.md' })
    ])
    expect(list).toEqual([
      { op: 'update', relPath: 'a.md', title: 'A2' },
      { op: 'retire', relPath: 'pasta/velha.md', title: '' }
    ])
  })

  it('op desconhecida vira create; entrada leve (sem input) não quebra', () => {
    expect(savedMemories([propose({ op: 'x', rel_path: 'z.md' }), { name: 'mcp__memory__memory_propose', result: ok }]))
      .toEqual([{ op: 'create', relPath: 'z.md', title: '' }, { op: 'create', relPath: '', title: '' }])
  })

  it('rótulo: título; sem ele, o nome do arquivo legível', () => {
    expect(memorySavedLabel({ op: 'create', relPath: 'x/regra-de-ouro.md', title: '' })).toBe('regra de ouro')
    expect(memorySavedLabel({ op: 'create', relPath: '', title: '' })).toBe('nova memória')
  })
})

describe('MemorySavedNote', () => {
  it('mostra o verbo e o título; nada quando vazio', () => {
    const { container, rerender } = render(<MemorySavedNote items={[{ op: 'create', relPath: 'a.md', title: 'Regra A' }, { op: 'retire', relPath: 'b.md', title: 'Velha' }]} animate />)
    expect(screen.getByText(/Anotei na memória/)).toBeTruthy()
    expect(screen.getByText('Regra A')).toBeTruthy()
    expect(screen.getByText(/Aposentei a memória/)).toBeTruthy()
    expect(container.querySelector('.mem-saved.fresh')).toBeTruthy()
    rerender(<MemorySavedNote items={[]} />)
    expect(container.querySelector('.mem-saved')).toBeNull()
  })
})
