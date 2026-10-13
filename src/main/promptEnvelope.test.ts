import { describe, expect, it } from 'vitest'
import { composeUserPrompt } from './promptEnvelope'
import { composeFromPromptBlocks, promptBlocks } from './contextSnapshot/blocks'

describe('composeUserPrompt — memórias do turno na mensagem', () => {
  const parts = {
    stamp: 'STAMP',
    memory: 'CATALOGO',
    relevantMemory: '--- Memória relevante: a.md ---\nA',
    skills: 'SKILLS',
    projects: '',
    others: 'OUTRAS'
  }

  it('entram logo depois do catálogo e antes das skills', () => {
    expect(composeUserPrompt('pedido', parts)).toBe(
      'STAMP\n\nCATALOGO\n\n--- Memória relevante: a.md ---\nA\n\nSKILLS\n\nOUTRAS\n\npedido'
    )
  })

  it('ausentes ou vazias não deixam rastro', () => {
    const { relevantMemory: _omit, ...without } = parts
    expect(composeUserPrompt('pedido', without)).toBe('STAMP\n\nCATALOGO\n\nSKILLS\n\nOUTRAS\n\npedido')
    expect(composeUserPrompt('pedido', { ...parts, relevantMemory: '' })).toBe(composeUserPrompt('pedido', without))
  })

  it('a decomposição em blocos reproduz o texto exato, com o bloco de trechos', () => {
    const blocks = promptBlocks('pedido', parts)
    expect(blocks.map((block) => block.kind)).toEqual(['stamp', 'memory-catalog', 'memory-excerpts', 'skills-catalog', 'others', 'user-request'])
    expect(composeFromPromptBlocks(blocks)).toBe(composeUserPrompt('pedido', parts))
  })
})
