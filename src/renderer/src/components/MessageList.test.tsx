import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { UIMessage } from '../types'
import { UiProvider } from '../ui/UiProvider'
import { MessageList } from './MessageList'

afterEach(cleanup)

Element.prototype.scrollIntoView = vi.fn()

const tts = { speakingId: null, onToggleSpeak: (): void => {} }

function userMessages(count: number): UIMessage[] {
  return Array.from({ length: count }, (_, i) => ({ kind: 'user', id: `u${i}`, text: `Mensagem ${i}` }))
}

function messageList(messages: UIMessage[]): JSX.Element {
  return (
    <UiProvider>
      <MessageList messages={messages} busy={false} tts={tts} onRetry={() => {}} />
    </UiProvider>
  )
}

function mockScrollBox(el: HTMLElement, scrollTop: number): void {
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, value: 2_000 },
    clientHeight: { configurable: true, value: 400 },
    scrollTop: { configurable: true, writable: true, value: scrollTop }
  })
}

function rect(top: number): DOMRect {
  return { top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20, x: 0, y: top, toJSON: () => ({}) }
}

describe('MessageList - janela e ancora de scroll', () => {
  it('mantem a primeira row renderizada quando chegam mensagens enquanto o usuario le o historico', () => {
    const initial = userMessages(80)
    const view = render(messageList(initial))
    const list = view.container.querySelector<HTMLElement>('.message-list')!

    expect(list.querySelector<HTMLElement>('.msg.user')?.dataset.mid).toBe('u40')
    mockScrollBox(list, 1_000)
    fireEvent.scroll(list)

    view.rerender(messageList([...initial, { kind: 'user', id: 'u80', text: 'Mensagem 80' }]))

    expect(list.querySelector<HTMLElement>('.msg.user')?.dataset.mid).toBe('u40')
    expect(list.querySelectorAll('.msg.user')).toHaveLength(41)
  })

  it('ancora pelo mesmo no DOM ao revelar a pagina anterior', () => {
    const view = render(messageList(userMessages(80)))
    const list = view.container.querySelector<HTMLElement>('.message-list')!
    const anchor = list.querySelector<HTMLElement>('.msg.user')!
    mockScrollBox(list, 40)
    vi.spyOn(anchor, 'getBoundingClientRect')
      .mockReturnValueOnce(rect(120))
      .mockReturnValue(rect(360))

    fireEvent.scroll(list)

    expect(list.querySelectorAll('.msg.user')).toHaveLength(80)
    expect(list.scrollTop).toBe(280)
  })
})

describe('MessageList - anexo no ponto do texto', () => {
  it('bolha com {{midia:N}}: miniatura e chip no lugar, prévia ampliada no hover', () => {
    const view = render(
      messageList([
        {
          kind: 'user',
          id: 'u1',
          text: 'analisa {{midia:1}} e compare com {{midia:2}}.',
          images: ['data:image/png;base64,AAAA'],
          files: [{ name: 'dados.csv', size: 2048 }],
          media: [
            { t: 'i', i: 0, name: 'tela.png' },
            { t: 'f', i: 0 }
          ]
        }
      ])
    )
    const bubble = view.container.querySelector('.msg.user .bubble')!
    expect(bubble.textContent).toBe('analisa  e compare com CSVdados.csv.')
    const img = view.getByAltText('midia:1 = tela.png')
    // a imagem fica ENTRE os trechos de texto, não numa faixa em cima
    expect(img.previousSibling?.textContent).toBe('analisa ')
    expect(bubble.querySelector('.msg-images, .msg-files')).toBeNull()
    expect(view.getByLabelText('midia:2 = dados.csv · 2 KB')).toBeTruthy()
    fireEvent.mouseEnter(img)
    expect(view.getByRole('tooltip').querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    fireEvent.mouseLeave(img)
    expect(view.queryByRole('tooltip')).toBeNull()
  })

  it('imagem que não voltou do banco (miniaturas não são gravadas) vira chip com o nome, no mesmo lugar', () => {
    const view = render(
      messageList([{ kind: 'user', id: 'u1', text: 'veja {{midia:1}}!', media: [{ t: 'i', i: 0, name: 'tela.png' }] }])
    )
    expect(view.container.querySelector('.bubble')!.textContent).toBe('veja IMGtela.png!')
  })

  it('mensagem antiga, sem índice: anexos em cima e o texto como sempre (marcador digitado fica texto)', () => {
    const view = render(
      messageList([
        { kind: 'user', id: 'u1', text: 'oi {{midia:1}}', images: ['data:image/png;base64,AAAA'], files: [{ name: 'a.pdf', size: 0 }] }
      ])
    )
    const bubble = view.container.querySelector('.msg.user .bubble')!
    expect(bubble.querySelector('.msg-images img')).toBeTruthy()
    expect(bubble.querySelector('.msg-files')).toBeTruthy()
    expect(bubble.textContent).toContain('oi {{midia:1}}')
  })
})

describe('MessageList - resposta interrompida', () => {
  it('explica visualmente quando a resposta do assistente ficou incompleta', () => {
    const view = render(
      messageList([
        { kind: 'assistant-text', id: 'a1', text: 'Resposta cortada no me', final: true, aborted: true }
      ])
    )
    expect(view.getByText('Resposta interrompida pelo Stop — pode estar incompleta.')).toBeTruthy()
    expect(view.container.querySelector('.msg.assistant.aborted')).toBeTruthy()
  })
})
