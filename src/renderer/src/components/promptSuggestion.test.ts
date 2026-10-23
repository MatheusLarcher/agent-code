import { describe, expect, it } from 'vitest'
import { appendInjected, withSuggestion } from './promptSuggestion'

describe('appendInjected — o texto do chip no campo', () => {
  it('caixa vazia (ou só espaços) recebe o texto', () => {
    expect(appendInjected('', 'Rode os testes')).toBe('Rode os testes')
    expect(appendInjected('  \n', 'Rode os testes')).toBe('Rode os testes')
  })

  it('com texto, entra no fim depois de UM espaço', () => {
    expect(appendInjected('Revise o diff', 'e rode os testes')).toBe('Revise o diff e rode os testes')
    expect(appendInjected('Revise o diff  \n', 'e rode os testes')).toBe('Revise o diff e rode os testes')
  })
})

describe('withSuggestion — o mapa conversa → sugestão do App', () => {
  it('põe, troca e tira; o mesmo objeto quando nada muda', () => {
    const vazio = {}
    const um = withSuggestion(vazio, 'c1', 'Rode os testes')
    expect(um).toEqual({ c1: 'Rode os testes' })
    expect(withSuggestion(um, 'c1', 'Rode os testes')).toBe(um)
    expect(withSuggestion(um, 'c1', 'Faça o commit')).toEqual({ c1: 'Faça o commit' })
    expect(withSuggestion(um, 'c1', null)).toEqual({})
    expect(withSuggestion(vazio, 'c1', null)).toBe(vazio)
  })
})
