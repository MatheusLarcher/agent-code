import { describe, expect, it } from 'vitest'
import {
  isValidMediaName,
  MAX_ANEXOS_POR_CARD,
  MAX_MEDIA_BYTES,
  MAX_MEDIA_PREVIEW_BYTES,
  MEDIA_DIR,
  MEDIA_KIND_LABEL,
  mediaFileName,
  mediaKindOf,
  type MediaKind
} from './planningMedia'

describe('constantes de mídia', () => {
  it('seguem a spec', () => {
    expect(MEDIA_DIR).toBe('midia')
    expect(MAX_MEDIA_BYTES).toBe(200 * 1024 * 1024)
    expect(MAX_MEDIA_PREVIEW_BYTES).toBe(20 * 1024 * 1024)
    expect(MAX_ANEXOS_POR_CARD).toBe(20)
  })

  it('todo tipo tem rótulo', () => {
    const kinds: MediaKind[] = [
      'imagem', 'pdf', 'video', 'audio', 'planilha', 'documento', 'apresentacao', 'texto', 'compactado', 'outro'
    ]
    for (const k of kinds) expect(MEDIA_KIND_LABEL[k]).toBeTruthy()
    expect(MEDIA_KIND_LABEL.imagem).toBe('Imagem')
    expect(MEDIA_KIND_LABEL.pdf).toBe('PDF')
    expect(MEDIA_KIND_LABEL.video).toBe('Vídeo')
  })
})

describe('mediaKindOf', () => {
  it('classifica pela extensão, sem diferenciar caixa, de nome ou caminho', () => {
    const cases: Array<[string, MediaKind]> = [
      ['tela.PNG', 'imagem'],
      ['C:\\x\\foto.jpeg', 'imagem'],
      ['/a/b/manual.pdf', 'pdf'],
      ['demo.mp4', 'video'],
      ['clip.webm', 'video'],
      ['aula.mov', 'video'],
      ['musica.mp3', 'audio'],
      ['voz.m4a', 'audio'],
      ['dados.xlsx', 'planilha'],
      ['dados.csv', 'planilha'],
      ['contrato.docx', 'documento'],
      ['deck.pptx', 'apresentacao'],
      ['leia.md', 'texto'],
      ['log.txt', 'texto'],
      ['codigo.ts', 'texto'],
      ['pacote.zip', 'compactado'],
      ['binario.exe', 'outro'],
      ['sem-extensao', 'outro'],
      ['', 'outro']
    ]
    for (const [name, kind] of cases) expect(mediaKindOf(name), name).toBe(kind)
  })
})

describe('isValidMediaName', () => {
  it('aceita o formato saneado', () => {
    for (const ok of ['a1b2c3-tela-de-login.png', 'a', 'x_y-z', 'abc.tar', 'a.1234567890', 'x'.repeat(120)]) {
      expect(isValidMediaName(ok), ok).toBe(true)
    }
  })

  it('recusa separador, .., maiúscula, espaço, acento, tamanho e nome de dispositivo do Windows', () => {
    const bad: unknown[] = [
      '', '-a', '_a', '.png', 'a/b.png', 'a\\b.png', '..', 'a..b', 'a.b.c', 'A.png', 'a b.png', 'ção.png',
      'a.12345678901', 'a.', 'x'.repeat(121), 'con', 'NUL', 'nul.txt', 'com1.png', 'lpt9', 12, null, undefined
    ]
    for (const b of bad) expect(isValidMediaName(b), String(b)).toBe(false)
  })
})

describe('mediaFileName', () => {
  it('tira acento, põe em minúsculas, troca o resto por - e preserva a extensão', () => {
    expect(mediaFileName('Tela de Login.PNG', 'a1b2c3')).toBe('a1b2c3-tela-de-login.png')
    expect(mediaFileName('Relatório Final (v2).pdf', 'ffffff')).toBe('ffffff-relatorio-final-v2.pdf')
  })

  it('usa só o nome base de um caminho', () => {
    expect(mediaFileName('C:\\Users\\x\\Área de Trabalho\\foto.jpg', 'abcdef')).toBe('abcdef-foto.jpg')
    expect(mediaFileName('/tmp/../etc/passwd', 'abcdef')).toBe('abcdef-passwd')
  })

  it('nome vazio ou só símbolos vira "arquivo"; extensão inválida some', () => {
    expect(mediaFileName('', 'abcdef')).toBe('abcdef-arquivo')
    expect(mediaFileName('!!!.png', 'abcdef')).toBe('abcdef-arquivo.png')
    expect(mediaFileName('.gitignore', 'abcdef')).toBe('abcdef-gitignore')
    expect(mediaFileName('nota.extensaolonga', 'abcdef')).toBe('abcdef-nota')
  })

  it('o resultado é sempre um nome válido de até 120 caracteres', () => {
    const inputs = ['x'.repeat(500) + '.png', 'ÁÉÍ ÓÚ ç ñ.MP4', '..\\..\\a', 'a.b.c.d', 'CON.txt', '😀 emoji.gif']
    for (const input of inputs) {
      const name = mediaFileName(input, 'a1b2c3')
      expect(isValidMediaName(name), `${input} → ${name}`).toBe(true)
      expect(name.length).toBeLessThanOrEqual(120)
      expect(name.startsWith('a1b2c3-')).toBe(true)
    }
    expect(mediaFileName('x'.repeat(500) + '.png', 'a1b2c3').endsWith('.png')).toBe(true)
  })

  it('recusa prefixo inválido', () => {
    for (const p of ['', 'ABC', 'a-b', 'a/b']) expect(() => mediaFileName('a.png', p), p).toThrow(/prefixo/)
  })
})
