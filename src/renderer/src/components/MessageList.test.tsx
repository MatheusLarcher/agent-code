import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { UIMessage } from '../types'
import { UiProvider } from '../ui/UiProvider'
import { MessageList } from './MessageList'
import { UI_MOCKUP_CSP } from '@shared/uiMockup'

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

describe('MessageList - mockup artifact', () => {
  it('renders a persisted artifact inline in one sandboxed iframe', () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${UI_MOCKUP_CSP}"><style>.wmd-root{color:#111}</style></head><body class="wmd-root wmd-clean"><h1>Checkout preview</h1></body></html>`
    const view = render(
      messageList([
        {
          kind: 'ui-mockup',
          artifact: {
            type: 'ui_mockup',
            id: 'mockup-1',
            version: 2,
            title: 'Checkout',
            source: '# Checkout',
            html,
            viewport: 'mobile'
          },
          parentToolUseId: null
        }
      ])
    )
    const frame = view.getByTitle('Checkout') as HTMLIFrameElement
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame.srcdoc).toContain('Checkout preview')
    expect(frame.srcdoc).not.toMatch(/<iframe\b/i)
    expect(view.container.querySelectorAll('iframe')).toHaveLength(1)
    expect(view.container.querySelector('.ui-mockup-card.mobile')).toBeTruthy()
    expect(view.container.querySelector('.ui-mockup-viewport.mobile')).toBeTruthy()
  })

  it('never renders a persisted WireMD tool card or its source', () => {
    const view = render(messageList([{
      kind: 'tool-use',
      id: 'wm1',
      name: 'mcp__wiremd__render_ui_mockup',
      input: { title: 'Segredo', source: '# SOURCE NÃO DEVE APARECER' },
      parentToolUseId: null
    }]))

    expect(view.container.querySelector('.tool-card')).toBeNull()
    expect(view.container.textContent).not.toContain('SOURCE NÃO DEVE APARECER')
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
