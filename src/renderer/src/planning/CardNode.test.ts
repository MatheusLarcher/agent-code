import { describe, it, expect } from 'vitest'
import { bodyPreview, sourceHost } from './CardNode'

describe('bodyPreview', () => {
  it('pega as 3 primeiras linhas com texto, sem marcador markdown', () => {
    const corpo = '# Título\n\n- item **forte**\n> citação\n1. quarto\nquinto'
    expect(bodyPreview(corpo)).toEqual(['Título', 'item forte', 'citação'])
  })

  it('pula régua e cerca de código; corpo vazio dá lista vazia', () => {
    expect(bodyPreview('---\n```ts\nconst a = 1\n```')).toEqual(['const a = 1'])
    expect(bodyPreview('')).toEqual([])
  })
})

describe('sourceHost', () => {
  it('mostra só o domínio, sem www; texto que não é URL volta como veio', () => {
    expect(sourceHost('https://www.exemplo.com/a/b?c=1')).toBe('exemplo.com')
    expect(sourceHost('nao-e-url')).toBe('nao-e-url')
  })
})
