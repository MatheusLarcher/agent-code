import { describe, expect, it } from 'vitest'
import { imageContentBlocks, splitMediaText } from '../../shared/inlineMedia'
import { buildImageMessage, checkImage, MCP_MAX_IMAGE_BYTES, sanitizeImageName, sniffImageMime, type McpImageArg } from './mcpImages'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')])

const img = (nome: string, mime: McpImageArg['mime'], bytes: Buffer): McpImageArg => ({ nome, mime, base64: bytes.toString('base64') })
const png = (nome = 'a.png'): McpImageArg => img(nome, 'image/png', PNG)

describe('sniffImageMime / checkImage', () => {
  it('reconhece PNG, JPEG e WEBP pelos bytes iniciais', () => {
    expect(sniffImageMime(PNG)).toBe('image/png')
    expect(sniffImageMime(JPEG)).toBe('image/jpeg')
    expect(sniffImageMime(WEBP)).toBe('image/webp')
    expect(sniffImageMime(Buffer.from('GIF89a'))).toBeNull()
    expect(checkImage(png(), 1)).toBeNull()
    expect(checkImage(img('b.jpg', 'image/jpeg', JPEG), 2)).toBeNull()
    expect(checkImage(img('c.webp', 'image/webp', WEBP), 3)).toBeNull()
  })

  it('recusa mime que não bate com os bytes, bytes desconhecidos e base64 inválido', () => {
    expect(checkImage(img('x.png', 'image/png', JPEG), 1)).toBe('imagens[1] (x.png): mime diz image/png, mas os bytes são image/jpeg')
    expect(checkImage(img('x.webp', 'image/webp', Buffer.from('GIF89a......')), 2)).toMatch(/não são PNG, JPEG nem WEBP/)
    for (const base64 of ['não é base64!', 'iVBORw0KGgo', 'data:image/png;base64,iVBORw0KGgo=', 'iVBO Rw0K']) {
      expect(checkImage({ nome: 'x.png', mime: 'image/png', base64 }, 1)).toMatch(/base64 inválido/)
    }
  })

  it('até 5 MB decodificado passa; um byte a mais é recusado', () => {
    const exact = Buffer.alloc(MCP_MAX_IMAGE_BYTES)
    PNG.copy(exact)
    expect(checkImage(img('grande.png', 'image/png', exact), 1)).toBeNull()
    const over = Buffer.alloc(MCP_MAX_IMAGE_BYTES + 1)
    PNG.copy(over)
    expect(checkImage(img('grande.png', 'image/png', over), 4)).toMatch(/^imagens\[4\] \(grande\.png\): passa de 5 MB/)
  })

  it('nome: sem pasta (Windows ou Unix), sem controle, com reserva', () => {
    expect(sanitizeImageName('C:\\Users\\x\\peça.png', 1)).toBe('peça.png')
    expect(sanitizeImageName('../../etc/passwd', 1)).toBe('passwd')
    expect(sanitizeImageName('a\u0000b\nc.png', 1)).toBe('a b c.png')
    expect(sanitizeImageName('..', 3)).toBe('imagem-3')
    expect(sanitizeImageName('dir/', 2)).toBe('imagem-2')
  })
})

describe('buildImageMessage — [[imagem:N]] no formato do composer ({{midia:N}})', () => {
  it('sem imagens nem marcadores: o prompt sai idêntico', () => {
    expect(buildImageMessage('faça o chaveiro', [])).toEqual({ text: 'faça o chaveiro', images: [] })
  })

  it('marcador no meio: a imagem entra exatamente ali, rotulada', () => {
    const out = buildImageMessage('compare [[imagem:1]] com a peça', [png('ref.png')])
    expect(out).toEqual({
      text: 'compare {{midia:1}} com a peça',
      images: [{ mediaType: 'image/png', data: PNG.toString('base64'), label: 'midia:1 = ref.png' }]
    })
  })

  it('N do texto segue a ORDEM no texto (como no composer), não a posição no array', () => {
    const out = buildImageMessage('antes [[imagem:2]] depois [[imagem:1]]', [png('um.png'), png('dois.png')])
    if ('erro' in out) throw new Error(out.erro)
    expect(out.text).toBe('antes {{midia:1}} depois {{midia:2}}')
    expect(out.images.map((i) => i.label)).toEqual(['midia:1 = dois.png', 'midia:2 = um.png'])
    // A bolha e o agente leem o mesmo par (shared/inlineMedia): texto, mídia 1, texto, mídia 2.
    expect(splitMediaText(out.text)).toEqual([{ text: 'antes ' }, { media: 1 }, { text: ' depois ' }, { media: 2 }])
    expect(imageContentBlocks(out.images)[0]).toEqual({ type: 'text', text: 'midia:1 = dois.png' })
  })

  it('imagem sem marcador vai no fim da mensagem', () => {
    const out = buildImageMessage('veja [[imagem:2]]', [png('a.png'), png('b.png'), png('c.png')])
    if ('erro' in out) throw new Error(out.erro)
    expect(out.text).toBe('veja {{midia:1}}\n\n{{midia:2}} {{midia:3}}')
    expect(out.images.map((i) => i.label)).toEqual(['midia:1 = b.png', 'midia:2 = a.png', 'midia:3 = c.png'])
    const none = buildImageMessage('sem marcador', [png('x.png')])
    expect(none).toMatchObject({ text: 'sem marcador\n\n{{midia:1}}' })
  })

  it('o mesmo marcador duas vezes aponta a mesma imagem (um anexo só)', () => {
    const out = buildImageMessage('[[imagem:1]] e de novo [[imagem:1]]', [png('a.png')])
    if ('erro' in out) throw new Error(out.erro)
    expect(out.text).toBe('{{midia:1}} e de novo {{midia:1}}')
    expect(out.images).toHaveLength(1)
  })

  it('marcador sem imagem correspondente é erro de validação', () => {
    expect(buildImageMessage('veja [[imagem:3]]', [png(), png()])).toEqual({
      erro: 'prompt: [[imagem:3]] sem imagem correspondente (vieram 2 imagem(ns); N começa em 1)'
    })
    expect(buildImageMessage('veja [[imagem:0]]', [png()])).toMatchObject({ erro: expect.stringMatching(/\[\[imagem:0\]\]/) })
    expect(buildImageMessage('veja [[imagem:1]]', [])).toEqual({
      erro: 'prompt: [[imagem:1]] sem imagem correspondente (nenhuma imagem veio; N começa em 1)'
    })
  })

  it('{{midia:N}} escrito pelo chamador junto com imagens é recusado (marcador interno)', () => {
    expect(buildImageMessage('olhe {{midia:1}}', [png()])).toMatchObject({ erro: expect.stringMatching(/use|marque/) })
  })
})
