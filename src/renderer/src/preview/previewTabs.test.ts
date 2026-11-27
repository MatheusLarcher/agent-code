import { describe, expect, it } from 'vitest'
import { dirOf, extLabel, makeTab, normalizeTarget, opensInWebview, resolveRelativeLink, targetKey, titleFor } from './previewTabs'

describe('normalizeTarget', () => {
  it('link http(s) fica como está', () => {
    expect(normalizeTarget('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(normalizeTarget('  "http://localhost:3000/"  ')).toBe('http://localhost:3000/')
  })

  it('file: vira caminho do disco', () => {
    expect(normalizeTarget('file:///C:/a/b.md')).toBe('C:\\a\\b.md')
    expect(normalizeTarget('file:///C:/minha%20pasta/x.txt')).toBe('C:\\minha pasta\\x.txt')
  })

  it('caminho absoluto fica como está', () => {
    expect(normalizeTarget('C:\\x\\y.csv')).toBe('C:\\x\\y.csv')
    expect(normalizeTarget('/home/x/a.md')).toBe('/home/x/a.md')
    expect(normalizeTarget('<C:\\x.md>')).toBe('C:\\x.md')
  })

  it('esquema que não é site nem arquivo: recusa', () => {
    expect(normalizeTarget('mailto:x@y.com')).toBeNull()
    expect(normalizeTarget('javascript:alert(1)')).toBeNull()
  })

  it('localhost ganha http://; domínio com porta ganha https://', () => {
    expect(normalizeTarget('localhost:5173')).toBe('http://localhost:5173')
    expect(normalizeTarget('127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x')
    expect(normalizeTarget('example.com:8080')).toBe('https://example.com:8080')
  })

  it('nome de arquivo relativo usa a pasta do projeto; sem ela, recusa', () => {
    expect(normalizeTarget('a.md', 'C:\\proj')).toBe('C:\\proj\\a.md')
    expect(normalizeTarget('a.md')).toBeNull()
  })

  it('domínio solto vira https; vazio e texto qualquer recusam', () => {
    expect(normalizeTarget('example.com')).toBe('https://example.com')
    expect(normalizeTarget('')).toBeNull()
    expect(normalizeTarget('   ')).toBeNull()
    expect(normalizeTarget('qualquer coisa')).toBeNull()
  })
})

describe('regras das abas', () => {
  it('targetKey junta o mesmo alvo escrito de jeitos diferentes', () => {
    expect(targetKey('https://example.com/')).toBe(targetKey('https://example.com'))
    expect(targetKey('C:/Proj/A.md')).toBe(targetKey('c:\\proj\\a.md'))
  })

  it('titleFor: host do site ou nome do arquivo', () => {
    expect(titleFor('https://example.com/x/y')).toBe('example.com')
    expect(titleFor('C:\\a\\relatorio.md')).toBe('relatorio.md')
    expect(titleFor('/home/x/b.csv')).toBe('b.csv')
  })

  it('makeTab dá id novo, tipo e título', () => {
    const a = makeTab('C:\\a\\b.md')
    const b = makeTab('C:\\a\\b.md')
    expect(a.id).toMatch(/^pv-/)
    expect(a.id).not.toBe(b.id)
    expect(a).toMatchObject({ kind: 'markdown', target: 'C:\\a\\b.md', title: 'b.md' })
    expect(makeTab('https://x.com').kind).toBe('web')
  })

  it('opensInWebview: site, html e mídia', () => {
    expect(opensInWebview({ kind: 'web' })).toBe(true)
    expect(opensInWebview({ kind: 'html' })).toBe(true)
    expect(opensInWebview({ kind: 'media' })).toBe(true)
    expect(opensInWebview({ kind: 'markdown' })).toBe(false)
    expect(opensInWebview({ kind: 'table' })).toBe(false)
  })

  it('extLabel: extensão em maiúsculas, nada em site', () => {
    expect(extLabel('C:\\a\\b.xlsx')).toBe('XLSX')
    expect(extLabel('https://x.com/a.md')).toBe('')
  })
})

describe('link relativo de arquivo aberto no Preview', () => {
  it('dirOf: pasta do arquivo', () => {
    expect(dirOf('C:\\docs\\a.md')).toBe('C:\\docs')
    expect(dirOf('/x/y.md')).toBe('/x')
    expect(dirOf('/y.md')).toBe('/')
  })

  it('resolve a partir da pasta do .md, com . / .. / %20', () => {
    expect(resolveRelativeLink('b.md', 'C:\\docs')).toBe('C:\\docs\\b.md')
    expect(resolveRelativeLink('./sub/c.md', 'C:\\docs')).toBe('C:\\docs\\sub\\c.md')
    expect(resolveRelativeLink('../img/a.png', 'C:\\docs\\notas')).toBe('C:\\docs\\img\\a.png')
    expect(resolveRelativeLink('pasta%20x/c.md#titulo', 'C:\\docs')).toBe('C:\\docs\\pasta x\\c.md')
    expect(resolveRelativeLink('../../../a.md', 'C:\\docs')).toBe('C:\\a.md')
    expect(resolveRelativeLink('b.md', '/home/u')).toBe('/home/u/b.md')
  })

  it('não relativo ou não abrível → null (segue o caminho normal)', () => {
    expect(resolveRelativeLink('#secao', 'C:\\docs')).toBeNull()
    expect(resolveRelativeLink('https://x.com/a.md', 'C:\\docs')).toBeNull()
    expect(resolveRelativeLink('file:///C:/a.md', 'C:\\docs')).toBeNull()
    expect(resolveRelativeLink('C:\\outra\\a.md', 'C:\\docs')).toBeNull()
    expect(resolveRelativeLink('\\\\srv\\a.md', 'C:\\docs')).toBeNull()
    expect(resolveRelativeLink('mailto:a@b.com', 'C:\\docs')).toBeNull()
    expect(resolveRelativeLink('programa.exe', 'C:\\docs')).toBeNull()
    expect(resolveRelativeLink('b.md', '')).toBeNull()
  })
})
