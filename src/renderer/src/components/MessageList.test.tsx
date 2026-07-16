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
