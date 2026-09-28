import { describe, it, expect } from 'vitest'
import {
  hasMediaMarkers,
  imageContentBlocks,
  mediaLabel,
  mediaLabelNumber,
  mediaMarker,
  orderByMediaLabel,
  readableMediaText,
  sanitizeMediaLabel,
  splitMediaText
} from './inlineMedia'

describe('inlineMedia — marcador e rótulo', () => {
  it('marcador e rótulo no formato combinado', () => {
    expect(mediaMarker(3)).toBe('{{midia:3}}')
    expect(mediaLabel(1, 'foto.png')).toBe('midia:1 = foto.png')
    // nome numa linha só (vai ao modelo): sem quebra/controle
    expect(mediaLabel(2, 'a\nb\tc.png')).toBe('midia:2 = a b c.png')
  })

  it('rótulo da fronteira de IPC: só o formato esperado passa', () => {
    expect(sanitizeMediaLabel('midia:12 = nota.pdf')).toBe('midia:12 = nota.pdf')
    expect(sanitizeMediaLabel('midia:1 = a\nb')).toBeUndefined()
    expect(sanitizeMediaLabel('qualquer coisa')).toBeUndefined()
    expect(sanitizeMediaLabel(42)).toBeUndefined()
    expect(mediaLabelNumber('midia:7 = x')).toBe(7)
    expect(mediaLabelNumber(undefined)).toBeNull()
  })

  it('quebra o texto nos marcadores (início, meio, fim, colado a palavras)', () => {
    expect(splitMediaText('{{midia:1}}abc{{midia:2}}d{{midia:3}}')).toEqual([
      { media: 1 },
      { text: 'abc' },
      { media: 2 },
      { text: 'd' },
      { media: 3 }
    ])
    expect(splitMediaText('sem marcador')).toEqual([{ text: 'sem marcador' }])
    expect(hasMediaMarkers('x {{midia:1}}')).toBe(true)
    expect(hasMediaMarkers('{{midia:}} {midia:1}')).toBe(false)
  })

  it('texto legível para onde não dá para mostrar o anexo', () => {
    expect(readableMediaText('analisa {{midia:1}} e {{midia:2}}')).toBe('analisa [mídia 1] e [mídia 2]')
  })

  it('ordena pelo N do rótulo; sem rótulo vai depois, na ordem original', () => {
    const out = orderByMediaLabel([
      { id: 'a' },
      { id: 'b', label: 'midia:2 = b' },
      { id: 'c', label: 'midia:1 = c' },
      { id: 'd' }
    ])
    expect(out.map((x) => x.id)).toEqual(['c', 'b', 'a', 'd'])
  })

  it('blocos de imagem: rótulo antes de cada imagem rotulada; sem rótulo, igual a antes', () => {
    expect(
      imageContentBlocks([
        { mediaType: 'image/png', data: 'A', label: 'midia:1 = a.png' },
        { mediaType: 'image/png', data: 'B' }
      ])
    ).toEqual([
      { type: 'text', text: 'midia:1 = a.png' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B' } }
    ])
  })
})
