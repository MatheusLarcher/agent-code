import { describe, expect, it } from 'vitest'
import { buildInjectedMessage, INJECT_NOW_MARKER } from './injectNow'

describe('mensagem "agora" (entra no turno em andamento)', () => {
  it('vai com priority next e marcada como ajuste que não cancela o pedido', () => {
    const msg = buildInjectedMessage('usa a pasta X', undefined, 'u1') as unknown as {
      priority: string
      uuid: string
      message: { content: string }
    }
    expect(msg.priority).toBe('next')
    expect(msg.uuid).toBe('u1')
    expect(msg.message.content).toBe(`${INJECT_NOW_MARKER}\n\nusa a pasta X`)
    expect(INJECT_NOW_MARKER).toMatch(/NÃO cancela/)
  })
  it('com imagem, blocos de imagem antes do texto', () => {
    const msg = buildInjectedMessage('olha isso', [{ mediaType: 'image/png', data: 'AAA' }], 'u2') as unknown as {
      message: { content: Array<{ type: string }> }
    }
    expect(msg.message.content.map((b) => b.type)).toEqual(['image', 'text'])
  })
})
