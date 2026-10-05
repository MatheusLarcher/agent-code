import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, renderHook, screen } from '@testing-library/react'
import type { UIMessage } from '../types'
import { UiProvider } from '../ui/UiProvider'
import { ChatDisplayContext, DEFAULT_CHAT_DISPLAY } from './chatDisplay'
import { MessageList, type TtsControls } from './MessageList'
import { useQuoteComments } from './quoteComment/useQuoteComments'

/**
 * Memo nas linhas do chat: com as mesmas mensagens, nada é redesenhado; com uma
 * mensagem nova (o pedaço da resposta em andamento), só a linha dela. E o que
 * vem do contexto da linha (busy, speakingId, hora, cards) continua atualizando.
 */

// Cada chamada ao react-markdown = um reprocessamento do texto.
const mdCalls = vi.hoisted(() => [] as string[])
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => {
    mdCalls.push(children)
    return <div className="md-mock">{children}</div>
  }
}))

// Cada render do QuotableMessage = um render da linha da resposta (AssistantRow).
const rowRenders = vi.hoisted(() => [] as string[])
vi.mock('./quoteComment/quoteBlocks', async (importActual) => {
  const actual = await importActual<typeof import('./quoteComment/quoteBlocks')>()
  return {
    ...actual,
    QuotableMessage: (props: Parameters<typeof actual.QuotableMessage>[0]) => {
      rowRenders.push(props.messageId)
      return actual.QuotableMessage(props)
    }
  }
})

Element.prototype.scrollIntoView = vi.fn()

beforeEach(() => {
  mdCalls.length = 0
  rowRenders.length = 0
})
afterEach(cleanup)

const noop = (): void => {}
const TTS: TtsControls = { speakingId: null, onToggleSpeak: noop }

const answer = (id: string, text: string, extra: Partial<Extract<UIMessage, { kind: 'assistant-text' }>> = {}): UIMessage => ({
  kind: 'assistant-text',
  id,
  text,
  final: true,
  answer: true,
  ...extra
})

const BASE: UIMessage[] = [
  { kind: 'user', id: 'u1', text: 'Primeira pergunta' },
  answer('a1', 'Resposta um'),
  { kind: 'user', id: 'u2', text: 'Segunda pergunta' },
  answer('a2', 'Resposta dois')
]

/** O que o ChatPanel faz: o `quote` do useQuoteComments(messages) vai para o MessageList. */
function Harness(props: {
  messages: UIMessage[]
  busy?: boolean
  tts?: TtsControls
  onRetry?: (id: string) => void
}): JSX.Element {
  const quote = useQuoteComments(props.messages)
  return (
    <MessageList
      messages={props.messages}
      busy={props.busy ?? false}
      tts={props.tts ?? TTS}
      onRetry={props.onRetry ?? noop}
      quote={quote.list}
    />
  )
}

function setup(first: Parameters<typeof Harness>[0], wrap: (n: ReactNode) => ReactNode = (n) => n) {
  const view = render(<UiProvider>{wrap(<Harness {...first} />)}</UiProvider>)
  return {
    ...view,
    rerenderWith: (next: Parameters<typeof Harness>[0], w = wrap): void =>
      view.rerender(<UiProvider>{w(<Harness {...next} />)}</UiProvider>)
  }
}

describe('chat memo — só a linha que mudou re-renderiza', () => {
  it('mesmas mensagens (array novo): nenhuma linha re-renderiza, react-markdown não roda de novo', () => {
    const view = setup({ messages: BASE })
    expect(rowRenders).toEqual(['a1', 'a2'])
    expect(mdCalls).toEqual(['Resposta um', 'Resposta dois'])
    rowRenders.length = 0
    mdCalls.length = 0

    view.rerenderWith({ messages: [...BASE] })

    expect(rowRenders).toEqual([])
    expect(mdCalls).toEqual([])
  })

  it('pedaço novo da resposta em andamento: só a linha dela re-renderiza e reprocessa', () => {
    const view = setup({ messages: BASE })
    rowRenders.length = 0
    mdCalls.length = 0

    const next = [...BASE.slice(0, 3), answer('a2', 'Resposta dois, agora maior')]
    view.rerenderWith({ messages: next })

    expect(rowRenders).toEqual(['a2'])
    expect(mdCalls).toEqual(['Resposta dois, agora maior'])
    expect(screen.getByText('Resposta dois, agora maior')).toBeTruthy()
  })

  it('mensagem nova no fim (ex.: ferramenta): as linhas antigas não re-renderizam', () => {
    const view = setup({ messages: BASE })
    rowRenders.length = 0
    mdCalls.length = 0

    view.rerenderWith({ messages: [...BASE, answer('a3', 'Narração nova', { answer: false })] })

    expect(rowRenders).toEqual(['a3'])
    expect(mdCalls).toEqual(['Narração nova'])
  })

  it('useQuoteComments: `list` estável enquanto as mensagens do usuário são as mesmas', () => {
    const wrapper = ({ children }: { children: ReactNode }): JSX.Element => <UiProvider>{children}</UiProvider>
    const hook = renderHook(({ messages }) => useQuoteComments(messages), { wrapper, initialProps: { messages: BASE } })
    const first = hook.result.current.list

    hook.rerender({ messages: [...BASE.slice(0, 3), answer('a2', 'Resposta dois, mais texto')] })
    expect(hook.result.current.list).toBe(first)

    // Uma bolha do usuário nova (pode trazer citações): o índice é refeito.
    hook.rerender({ messages: [...BASE, { kind: 'user', id: 'u3', text: 'Terceira' }] })
    expect(hook.result.current.list).not.toBe(first)
  })
})

describe('chat memo — o contexto da linha continua atualizando', () => {
  it('busy: o "Tentar de novo" habilita/desabilita', () => {
    const failed: UIMessage[] = [{ kind: 'user', id: 'u1', text: 'Falhou', error: 'sem rede' }]
    const view = setup({ messages: failed, busy: true })
    const retry = (): HTMLButtonElement => screen.getByRole('button', { name: /Tentar de novo/ }) as HTMLButtonElement
    expect(retry().disabled).toBe(true)

    view.rerenderWith({ messages: failed, busy: false })
    expect(retry().disabled).toBe(false)
  })

  it('speakingId: o "Ouvir" vira "Parar" na resposta que está sendo lida', () => {
    const view = setup({ messages: BASE })
    expect(screen.queryByRole('button', { name: /Parar/ })).toBeNull()

    view.rerenderWith({ messages: BASE, tts: { speakingId: 'a2', onToggleSpeak: noop } })
    const stop = screen.getByRole('button', { name: /Parar/ })
    expect(stop.closest('.msg')?.textContent).toContain('Resposta dois')
  })

  it('lastTsId: a hora sai da resposta anterior e vai para a nova', () => {
    const ts = new Date(2020, 0, 2, 10, 30).getTime()
    const withTs = [BASE[0], answer('a1', 'Resposta um', { ts })]
    const view = setup({ messages: withTs })
    const timeIn = (text: string): Element | null | undefined =>
      screen.getByText(text).closest('.msg')?.querySelector('.msg-time')
    expect(timeIn('Resposta um')).toBeTruthy()

    view.rerenderWith({ messages: [...withTs, answer('a2', 'Resposta dois', { ts: ts + 60_000 })] })
    expect(timeIn('Resposta um')).toBeNull()
    expect(timeIn('Resposta dois')).toBeTruthy()
  })

  it('resolveRef: cards novos no contexto viram chip na linha já desenhada', () => {
    const msgs: UIMessage[] = [{ kind: 'user', id: 'u1', text: 'Veja [[Login]] agora' }]
    const display = (cards: { id: string; titulo: string; tipo: 'nota' }[]) => (n: ReactNode) => (
      <ChatDisplayContext.Provider value={{ ...DEFAULT_CHAT_DISPLAY, cardRefs: cards }}>{n}</ChatDisplayContext.Provider>
    )
    const view = setup({ messages: msgs }, display([]))
    expect(document.querySelector('.pl-card-ref')).toBeNull()

    view.rerenderWith({ messages: msgs }, display([{ id: 'c1', titulo: 'Login', tipo: 'nota' }]))
    expect(document.querySelector('.pl-card-ref')?.textContent).toBe('Login')
  })
})
