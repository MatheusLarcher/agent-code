import { describe, expect, it } from 'vitest'
import { fonteKind, isHttpUrl, isProjectFileRef, isValidFonte } from './planningFonte'

describe('fonte do card — regra única', () => {
  it('URL http/https vale', () => {
    expect(isValidFonte('https://exemplo.com/artigo')).toBe(true)
    expect(isValidFonte('http://localhost:3000/docs')).toBe(true)
    expect(fonteKind('https://exemplo.com')).toBe('url')
    expect(isHttpUrl('ftp://x.org/a')).toBe(false)
  })

  it('arquivo do projeto vale, com ":linha" opcional', () => {
    for (const ok of ['src/a.ts:12', 'src/a.ts', 'src\\main\\x.ts:3', './Makefile', 'package.json', '.env', 'docs/spec/plano.md:120']) {
      expect(isValidFonte(ok), ok).toBe(true)
      expect(fonteKind(ok), ok).toBe('arquivo')
    }
  })

  it('recusa caminho que sobe de pasta ("..")', () => {
    for (const bad of ['../x', '../x.ts', 'src/../../etc/passwd', 'a/..\\b.ts', '..']) {
      expect(isValidFonte(bad), bad).toBe(false)
    }
  })

  it('recusa caminho absoluto, de unidade, UNC ou da home', () => {
    for (const bad of ['C:\\x', 'C:\\x\\a.ts', 'c:/a.ts', '/etc/passwd', '\\\\servidor\\a.ts', '~/a.ts']) {
      expect(isValidFonte(bad), bad).toBe(false)
    }
  })

  it('recusa vazio, texto solto e esquema que não é http(s)', () => {
    for (const bad of ['', '   ', 'minha cabeça', 'opiniao', 'ftp://x.org/a', 'javascript:alert(1)', 'file:///c/a.ts', 'src/', 'src/a.ts:0', 'src/a.ts:12:4', ' src/a.ts']) {
      expect(isValidFonte(bad), JSON.stringify(bad)).toBe(false)
    }
    expect(isValidFonte(undefined)).toBe(false)
    expect(isProjectFileRef(42)).toBe(false)
    expect(fonteKind('')).toBeNull()
  })

  it('recusa fonte longa demais', () => {
    expect(isValidFonte(`src/${'a'.repeat(5000)}.ts`)).toBe(false)
  })
})
