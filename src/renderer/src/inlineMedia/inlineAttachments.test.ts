import { describe, it, expect } from 'vitest'
import { TOKEN } from './editorModel'
import {
  bubbleMedia,
  makeFileAtt,
  makeImageAtt,
  makePendingAtt,
  makeRefAtt,
  sentCopyPath,
  serializeInline,
  userBubbleAttachments,
  type InlineAtt
} from './inlineAttachments'
import { fromDraft, toDraft } from './draftMedia'

describe('sentCopyPath — cópia do rascunho no envio', () => {
  it('tira só o segmento rascunho (qualquer caixa, \\ ou /) e mantém nome e extensão originais', () => {
    expect(sentCopyPath('C:\\ud\\attachments\\c1\\rascunho\\17-3-notes.md')).toBe('C:\\ud\\attachments\\c1\\17-3-notes.md')
    expect(sentCopyPath('C:\\ud\\attachments\\c1\\RASCUNHO\\17-4-dados.csv')).toBe('C:\\ud\\attachments\\c1\\17-4-dados.csv')
    expect(sentCopyPath('/home/u/.config/app/attachments/c1/rascunho/1-1-a.yaml')).toBe('/home/u/.config/app/attachments/c1/1-1-a.yaml')
    expect(sentCopyPath('C:\\docs\\plano.pdf')).toBe('C:\\docs\\plano.pdf')
    expect(sentCopyPath('C:\\rascunho\\sub\\a.txt')).toBe('C:\\rascunho\\sub\\a.txt')
  })

  it('serializeInline: arquivo com cópia do rascunho sai pelo caminho da pasta do envio', () => {
    const f = { ...file('notes.md'), stored: 'C:\\ud\\attachments\\c1\\rascunho\\9-9-notes.md' } as InlineAtt
    const { value, order, atts } = field(['ver ', f])
    const out = serializeInline(value, order, atts)
    expect(out.files).toEqual([])
    expect(out.fileRefs.map((r) => r.path)).toEqual(['C:\\ud\\attachments\\c1\\9-9-notes.md'])
  })
})

const img = (name = 'foto.png', data = 'AAAA'): InlineAtt => makeImageAtt({ mediaType: 'image/png', data }, name)
const file = (name = 'rel.pdf'): InlineAtt => makeFileAtt({ name, mediaType: 'application/pdf', data: 'UERG', size: 3 })
const ref = (name = 'dados.csv'): InlineAtt =>
  makeRefAtt({ name, path: `C:\\pasta\\${name}`, mediaType: 'text/csv', size: 9 })

function field(parts: Array<string | InlineAtt>): { value: string; order: string[]; atts: Map<string, InlineAtt> } {
  const atts = new Map<string, InlineAtt>()
  const order: string[] = []
  let value = ''
  for (const p of parts) {
    if (typeof p === 'string') value += p
    else {
      atts.set(p.id, p)
      order.push(p.id)
      value += TOKEN
    }
  }
  return { value, order, atts }
}

describe('serializeInline — texto + anexos para o agente', () => {
  it('0 anexos: o texto sai IDÊNTICO ao digitado (nada muda para quem não anexa)', () => {
    const text = '  corrige o bug\n\nem @src/a.ts  '
    expect(serializeInline(text, [], new Map())).toEqual({ text, images: [], files: [], fileRefs: [], elements: [] })
  })

  it('1 anexo no meio: {{midia:1}} no ponto exato e a imagem com o rótulo', () => {
    const a = img('tela.png')
    const f = field(['analisa a imagem ', a, ' e modifique'])
    const out = serializeInline(f.value, f.order, f.atts)
    expect(out.text).toBe('analisa a imagem {{midia:1}} e modifique')
    expect(out.images).toEqual([{ mediaType: 'image/png', data: 'AAAA', label: 'midia:1 = tela.png' }])
    expect(out.files).toEqual([])
    expect(out.fileRefs).toEqual([])
  })

  it('vários anexos de tipos diferentes: N é a ordem no texto, e cada lista segue a ordem N', () => {
    const [a, b, c, d] = [file('a.pdf'), img('b.png', 'BBBB'), ref('c.csv'), img('d.png', 'DDDD')]
    const f = field(['compare ', a, ' com ', b, ', depois ', c, ' e ', d])
    const out = serializeInline(f.value, f.order, f.atts)
    expect(out.text).toBe('compare {{midia:1}} com {{midia:2}}, depois {{midia:3}} e {{midia:4}}')
    expect(out.files.map((x) => x.label)).toEqual(['midia:1 = a.pdf'])
    expect(out.images.map((x) => x.label)).toEqual(['midia:2 = b.png', 'midia:4 = d.png'])
    expect(out.fileRefs.map((x) => x.label)).toEqual(['midia:3 = c.csv'])
    expect(out.fileRefs[0].path).toBe('C:\\pasta\\c.csv')
  })

  it('anexo no início, no fim e colado a palavras (sem espaço)', () => {
    const [a, b, c] = [img('a.png'), img('b.png'), img('c.png')]
    const f = field([a, 'antes', b, 'depois', c])
    expect(serializeInline(f.value, f.order, f.atts).text).toBe('{{midia:1}}antes{{midia:2}}depois{{midia:3}}')
    const only = field([a])
    expect(serializeInline(only.value, only.order, only.atts).text).toBe('{{midia:1}}')
  })

  it('anexo removido do texto não é enviado e a numeração fecha o buraco', () => {
    const [a, b] = [img('a.png'), img('b.png')]
    // o usuário apagou o primeiro item: ele continua no registro (desfazer), mas não no texto
    const atts = new Map([
      [a.id, a],
      [b.id, b]
    ])
    const out = serializeInline(`x ${TOKEN} y`, [b.id], atts)
    expect(out.text).toBe('x {{midia:1}} y')
    expect(out.images.map((i) => i.label)).toEqual(['midia:1 = b.png'])
  })

  it('item sem anexo no registro ou ainda resolvendo não vira marcador', () => {
    const p = makePendingAtt('C:\\pasta\\lento.bin')
    const f = field(['a', p, 'b'])
    expect(serializeInline(f.value, f.order, f.atts)).toEqual({ text: 'ab', images: [], files: [], fileRefs: [], elements: [] })
    expect(serializeInline(`a${TOKEN}b`, ['sumiu'], new Map()).text).toBe('ab')
  })
})

describe('rascunho com anexos', () => {
  it('ida e volta mantém posição e conteúdo, sem duplicar (imagem volta pelo caminho em disco)', () => {
    const a = { ...img('a.png'), stored: 'C:\\att\\c1\\1-a.png' } as InlineAtt
    const b = ref('b.csv')
    const f = field(['olha ', a, ' e ', b, '!'])
    const d = toDraft(f.value, f.order, f.atts)
    expect(d.text).toBe('olha {{midia:1}} e {{midia:2}}!')
    expect(d.media).toHaveLength(2)
    const back = fromDraft(d.text, JSON.parse(JSON.stringify(d.media)))
    expect(back.value).toBe(`olha ${TOKEN} e ${TOKEN}!`)
    // os dois voltam "resolvendo": a imagem é lida da cópia; o caminho colado é conferido no disco
    expect(back.atts.map((x) => x.kind)).toEqual(['pending', 'pending'])
    expect(back.restore).toEqual([
      { id: back.order[0], kind: 'image', name: 'a.png', mediaType: 'image/png', path: 'C:\\att\\c1\\1-a.png' },
      { id: back.order[1], kind: 'ref', name: 'b.csv', mediaType: 'text/csv', path: 'C:\\pasta\\b.csv', size: 9 }
    ])
    // um flush no meio da conferência grava o MESMO rascunho (nada se perde)
    const mid = toDraft(back.value, back.order, new Map(back.atts.map((x) => [x.id, x])))
    expect(mid).toEqual({ ...d, missing: [] })
  })

  it('rascunho só de texto (ou marcador digitado sem mídia) continua texto', () => {
    expect(fromDraft('oi {{midia:1}}', undefined)).toEqual({ value: 'oi {{midia:1}}', order: [], atts: [], restore: [] })
    expect(fromDraft('oi {{midia:2}}', [{ kind: 'image', name: 'a', mediaType: 'image/png', data: 'A' }]).value).toBe(
      'oi {{midia:2}}'
    )
    // lixo vindo do banco é ignorado
    expect(fromDraft('x {{midia:1}}', [{ kind: 'bomba' }]).value).toBe('x {{midia:1}}')
  })
})

describe('bolha do histórico', () => {
  it('índice {{midia:N}} -> imagem i / arquivo i (arquivos = files + fileRefs)', () => {
    const images = [{ mediaType: 'image/png', data: 'A', label: 'midia:2 = b.png' }]
    const files = [{ name: 'a.pdf', mediaType: 'application/pdf', data: 'x', size: 1, label: 'midia:1 = a.pdf' }]
    const fileRefs = [{ name: 'c.csv', path: '/c.csv', mediaType: 'text/csv', size: 2, label: 'midia:3 = c.csv' }]
    expect(bubbleMedia(images, files, fileRefs)).toEqual([
      { t: 'f', i: 0 },
      { t: 'i', i: 0, name: 'b.png' },
      { t: 'f', i: 1 }
    ])
  })

  it('mensagem sem rótulo (antiga/celular): bolha igual à de antes, sem índice', () => {
    const b = userBubbleAttachments(['data:image/png;base64,A'], [{ mediaType: 'image/png', data: 'A' }], [], [])
    expect(b).toEqual({ images: ['data:image/png;base64,A'], files: undefined })
    expect('media' in b).toBe(false)
  })
})
