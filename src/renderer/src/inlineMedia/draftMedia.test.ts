import { describe, expect, it, vi } from 'vitest'
import { resetConversationSync, syncConversations } from '../conversationSync'
import type { Conversation } from '../types'
import { TOKEN } from './editorModel'
import { applyDraft, fromDraft, isDraftMedia, replaceTokens, toDraft, type DraftMedia } from './draftMedia'
import { makeImageAtt, makePendingAtt, type InlineAtt } from './inlineAttachments'

const b64 = (bytes: number): string => 'A'.repeat(Math.ceil(bytes / 3) * 4)
const stored = (name: string, bytes: number): InlineAtt =>
  ({ ...makeImageAtt({ mediaType: 'image/png', data: b64(bytes) }, name), stored: `C:\\ud\\attachments\\c1\\1-${name}` }) as InlineAtt

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

describe('rascunho por referência (sem bytes)', () => {
  it('o tamanho do rascunho não cresce com o tamanho do arquivo', () => {
    const small = field(['olha ', stored('a.png', 30)])
    const big = field(['olha ', stored('a.png', 5 * 1024 * 1024)])
    const s = JSON.stringify(toDraft(small.value, small.order, small.atts).media)
    const b = JSON.stringify(toDraft(big.value, big.order, big.atts).media)
    expect(b.length).toBeLessThan(200)
    expect(b.length - s.length).toBeLessThan(10) // só os dígitos do `size`
    expect(b).not.toContain('AAAA')
  })

  it('imagem ainda sem cópia em disco não entra no rascunho: volta em `missing`', () => {
    const f = field(['x ', makeImageAtt({ mediaType: 'image/png', data: b64(99) }, 'solta.png')])
    expect(toDraft(f.value, f.order, f.atts)).toEqual({ text: 'x ', media: [], missing: ['solta.png'] })
  })

  it('item resolvendo entra com o id e a linha colada, e volta com o MESMO id', () => {
    const p = makePendingAtt('C:\\docs\\plano.pdf', 'C:\\docs\\plano.pdf')
    const f = field(['ver ', p, ' ok'])
    const d = toDraft(f.value, f.order, f.atts)
    expect(d.media).toEqual([{ kind: 'pending', id: p.id, name: 'plano.pdf', line: 'C:\\docs\\plano.pdf' }])
    const back = fromDraft(d.text, JSON.parse(JSON.stringify(d.media)))
    expect(back.order).toEqual([p.id])
    expect(back.restore).toEqual([{ id: p.id, kind: 'pending', line: 'C:\\docs\\plano.pdf' }])
    expect(back.value).toBe(`ver ${TOKEN} ok`)
  })

  it('rascunho antigo (com base64) continua sendo lido', () => {
    const legacy = [{ kind: 'image', name: 'velha.png', mediaType: 'image/png', data: 'QUJD' }]
    expect(isDraftMedia(legacy[0])).toBe(true)
    const back = fromDraft('antes {{midia:1}}', legacy)
    expect(back.atts[0]).toMatchObject({ kind: 'image', name: 'velha.png', image: { data: 'QUJD' } })
    expect(back.restore).toEqual([])
    // e o arquivo guardado por caminho volta "resolvendo": é relido da cópia (e o sumiço é avisado)
    const file = fromDraft('{{midia:1}}', [{ kind: 'file', name: 'r.pdf', mediaType: 'application/pdf', path: 'C:\\ud\\r.pdf', size: 9 }])
    expect(file.atts[0]).toMatchObject({ kind: 'pending', name: 'r.pdf' })
    expect(file.restore).toEqual([{ id: file.order[0], kind: 'file', name: 'r.pdf', mediaType: 'application/pdf', path: 'C:\\ud\\r.pdf' }])
  })

  it('replaceTokens troca só os itens pedidos e mantém a ordem dos outros', () => {
    expect(replaceTokens(`a${TOKEN}b${TOKEN}c`, ['x', 'y'], new Map([['x', 'LINHA']]))).toEqual({ value: `aLINHAb${TOKEN}c`, order: ['y'] })
  })
})

describe('applyDraft + gravação: blur sem mudança não regrava', () => {
  const conv = (extra: Partial<Conversation> = {}): Conversation =>
    ({
      id: 'c1',
      title: 't',
      cwd: 'C:/p',
      model: 'claude-sonnet-5-5',
      sdkSessionId: null,
      messages: [],
      tokens: { context: 0, output: 0, cost: 0 },
      createdAt: 1,
      updatedAt: 1,
      ...extra
    }) as Conversation

  it('mesmo texto e mesmos anexos devolvem a MESMA conversa (com e sem anexo)', () => {
    const media: DraftMedia[] = [{ kind: 'image', name: 'a.png', mediaType: 'image/png', path: 'C:\\a.png', size: 3 }]
    const c = conv({ draft: 'oi {{midia:1}}', draftMedia: media })
    expect(applyDraft(c, 'oi {{midia:1}}', JSON.parse(JSON.stringify(media)))).toBe(c)
    const plain = conv({ draft: 'oi' })
    expect(applyDraft(plain, 'oi')).toBe(plain)
    expect(applyDraft(conv(), '')).not.toHaveProperty('draftMedia', expect.anything())
    expect(applyDraft(c, 'oi {{midia:1}}')).not.toBe(c) // anexo saiu: muda
  })

  it('conta as entregas à fila: 1 na mudança, 0 nos blurs seguintes; payload sem o arquivo', () => {
    const payloads: string[] = []
    const sync = vi.fn((changes: unknown[]) => {
      payloads.push(JSON.stringify(changes))
    })
    Object.defineProperty(window, 'api', { configurable: true, value: { syncConversations: sync } })
    resetConversationSync()
    const img = stored('grande.png', 3 * 1024 * 1024)
    const f = field(['analisa ', img])
    const d = toDraft(f.value, f.order, f.atts)

    let list = [conv()]
    list = list.map((c) => applyDraft(c, d.text, d.media))
    syncConversations(list)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(payloads[0].length).toBeLessThan(1000) // 3 MB de imagem, payload de centenas de bytes

    // blur, blur, blur sem editar: o App nem troca o objeto, e nada é gravado
    for (let i = 0; i < 3; i++) {
      const again = toDraft(f.value, f.order, f.atts)
      const next = list.map((c) => applyDraft(c, again.text, again.media))
      expect(next[0]).toBe(list[0])
      syncConversations(next)
    }
    expect(sync).toHaveBeenCalledTimes(1)
  })
})
