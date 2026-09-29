import { describe, expect, it } from 'vitest'
import { TOKEN } from '../../inlineMedia/editorModel'
import { makeImageAtt, serializeInline, type InlineAtt } from '../../inlineMedia/inlineAttachments'
import { fromDraft, isDraftMedia, toDraft } from '../../inlineMedia/draftMedia'
import { makeQuoteAtt, quotesInOrder } from './quoteToken'

const q1 = makeQuoteAtt({ messageId: 'a1', text: 'Primeiro parágrafo.' }, 1)
const q2 = makeQuoteAtt({ messageId: 'a2', text: 'linha 1\nlinha 2' }, 2)
const img = makeImageAtt({ mediaType: 'image/png', data: 'AAAA' }, 'tela.png')
const reg = (...atts: InlineAtt[]): Map<string, InlineAtt> => new Map(atts.map((a) => [a.id, a]))

describe('serializeInline — o trecho como anexo inline', () => {
  it('dois trechos intercalados com o texto: citações primeiro, "[trecho N]" no ponto de cada anexo', () => {
    const value = `comentario ${TOKEN} do usuario.\ncomentario ${TOKEN} do usuario.`
    const out = serializeInline(value, [q1.id, q2.id], reg(q1, q2))
    expect(out.text).toBe(
      [
        '> [trecho 1] · mensagem a1',
        '> Primeiro parágrafo.',
        '',
        '> [trecho 2] · mensagem a2',
        '> linha 1',
        '> linha 2',
        '',
        'comentario [trecho 1] do usuario.',
        'comentario [trecho 2] do usuario.'
      ].join('\n')
    )
    expect(out.images).toEqual([])
  })

  it('N é a ordem no texto, não a do clique (nem o nome guardado no item)', () => {
    const out = serializeInline(`${TOKEN} x ${TOKEN}`, [q2.id, q1.id], reg(q1, q2))
    expect(out.text.startsWith('> [trecho 1] · mensagem a2\n')).toBe(true)
    expect(out.text.endsWith('\n\n[trecho 1] x [trecho 2]')).toBe(true)
  })

  it('convive com imagem: a mídia continua {{midia:1}} (o trecho não gasta número de mídia)', () => {
    const out = serializeInline(`${TOKEN} veja ${TOKEN} e ${TOKEN}`, [q1.id, img.id, q2.id], reg(q1, img, q2))
    expect(out.text.endsWith('\n\n[trecho 1] veja {{midia:1}} e [trecho 2]')).toBe(true)
    expect(out.images.map((i) => i.label)).toEqual(['midia:1 = tela.png'])
  })

  it('trecho apagado do texto (fora de `order`) não vai; só o trecho, sem texto, envia citação + marca', () => {
    expect(serializeInline('só texto', [], reg(q1)).text).toBe('só texto')
    expect(serializeInline(TOKEN, [q1.id], reg(q1)).text).toBe('> [trecho 1] · mensagem a1\n> Primeiro parágrafo.\n\n[trecho 1]')
  })
})

describe('rascunho com trecho', () => {
  it('ida e volta: o trecho vira item "quote" (só texto) e volta pronto, no mesmo lugar', () => {
    const d = toDraft(`sobre ${TOKEN} e ${TOKEN}`, [q1.id, img.id], reg(q1, { ...img, stored: 'C:\\x\\rascunho\\t.png' } as InlineAtt))
    expect(d.text).toBe('sobre {{midia:1}} e {{midia:2}}')
    expect(d.media[0]).toEqual({ kind: 'quote', messageId: 'a1', text: 'Primeiro parágrafo.' })
    expect(d.media.every(isDraftMedia)).toBe(true)
    const back = fromDraft(d.text, d.media)
    expect(back.value).toBe(`sobre ${TOKEN} e ${TOKEN}`)
    const atts = new Map(back.atts.map((a) => [a.id, a]))
    expect(quotesInOrder(back.order, atts).map((a) => a.quote)).toEqual([{ messageId: 'a1', text: 'Primeiro parágrafo.' }])
    // O trecho não precisa ser relido do disco.
    expect(back.restore.map((r) => r.kind)).toEqual(['image'])
  })

  it('item "quote" inválido no banco é ignorado', () => {
    expect(isDraftMedia({ kind: 'quote', messageId: 'a1' })).toBe(false)
    expect(isDraftMedia({ kind: 'quote', messageId: '', text: 'x' })).toBe(false)
  })
})
