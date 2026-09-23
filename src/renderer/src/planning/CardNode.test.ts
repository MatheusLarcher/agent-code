import { describe, it, expect } from 'vitest'
import { bodyPreview, sourceDisplay, sourceHost } from './CardNode'

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

describe('sourceDisplay', () => {
  it('URL vira link (pelo domínio); arquivo do projeto vira texto (nome:linha)', () => {
    expect(sourceDisplay('https://www.oauth.net/2/pkce/')).toEqual({ kind: 'url', label: 'oauth.net', href: 'https://www.oauth.net/2/pkce/' })
    expect(sourceDisplay('src/main/planning/planningModel.ts:12')).toEqual({ kind: 'arquivo', label: 'planningModel.ts:12' })
    expect(sourceDisplay('src\\a.ts')).toEqual({ kind: 'arquivo', label: 'a.ts' })
  })

  it('fonte que não é URL nem arquivo do projeto não aparece', () => {
    for (const bad of [undefined, '', '../fora.ts', 'C:\\x.ts', 'javascript:alert(1)']) {
      expect(sourceDisplay(bad), String(bad)).toBeNull()
    }
  })
})
