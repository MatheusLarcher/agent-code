import { describe, it, expect } from 'vitest'
import { extOf, isImageExt, looksLikeFileUrl, looksLikeLocalPath, mimeForExt } from './mime'

describe('looksLikeLocalPath — detecta caminho local colado como texto', () => {
  it('aceita caminho Windows absoluto', () => {
    expect(looksLikeLocalPath('C:\\Users\\mathe\\Documents\\relatorio.pdf')).toBe(true)
  })

  it('aceita caminho UNC (\\\\servidor\\share\\...)', () => {
    expect(looksLikeLocalPath('\\\\servidor\\compartilhado\\arquivo.docx')).toBe(true)
  })

  it('aceita caminho POSIX absoluto', () => {
    expect(looksLikeLocalPath('/home/usuario/arquivo.txt')).toBe(true)
  })

  it('rejeita texto comum (não é caminho)', () => {
    expect(looksLikeLocalPath('oi, tudo bem?')).toBe(false)
  })

  it('rejeita caminho relativo', () => {
    expect(looksLikeLocalPath('pasta/arquivo.txt')).toBe(false)
  })

  it('rejeita linha com espaços que não é só o caminho', () => {
    expect(looksLikeLocalPath('veja o arquivo C:\\a.pdf por favor')).toBe(false)
  })
})

describe('looksLikeFileUrl — detecta URL de arquivo colada como texto', () => {
  it('aceita URL http(s) terminando em extensão conhecida', () => {
    expect(looksLikeFileUrl('https://site.com/manual.pdf')).toBe(true)
  })

  it('aceita URL com querystring depois da extensão', () => {
    expect(looksLikeFileUrl('https://site.com/manual.pdf?token=abc&v=2')).toBe(true)
  })

  it('rejeita URL sem extensão reconhecida (página comum)', () => {
    expect(looksLikeFileUrl('https://site.com/sobre-nos')).toBe(false)
  })

  it('rejeita texto que não é URL', () => {
    expect(looksLikeFileUrl('não é um link')).toBe(false)
  })

  it('rejeita protocolo não-http', () => {
    expect(looksLikeFileUrl('ftp://site.com/arquivo.pdf')).toBe(false)
  })
})

describe('extOf / mimeForExt / isImageExt', () => {
  it('extrai extensão de nome de arquivo', () => {
    expect(extOf('relatorio.PDF')).toBe('pdf')
  })

  it('extrai extensão de URL com querystring', () => {
    expect(extOf('https://site.com/a/manual.docx?x=1')).toBe('docx')
  })

  it('mapeia mime conhecido e cai em octet-stream se desconhecido', () => {
    expect(mimeForExt('pdf')).toBe('application/pdf')
    expect(mimeForExt('xyz123')).toBe('application/octet-stream')
  })

  it('identifica extensão de imagem', () => {
    expect(isImageExt('png')).toBe(true)
    expect(isImageExt('pdf')).toBe(false)
  })
})
