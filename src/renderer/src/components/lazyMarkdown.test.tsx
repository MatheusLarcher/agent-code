import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { UIMessage } from '../types'
import { EAGER_ANSWERS, LazyMarkdown, LazyMarkdownProvider, useLazyAnswers } from './lazyMarkdown'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const answers = (n: number): UIMessage[] =>
  Array.from({ length: n }, (_, i) => ({ kind: 'assistant-text', id: `a${i}`, text: `**Resposta ${i}** com *ênfase*`, answer: true }) as UIMessage)

function Conversation({ messages }: { messages: UIMessage[] }): JSX.Element {
  const lazy = useLazyAnswers(messages)
  return (
    <LazyMarkdownProvider value={lazy}>
      {(messages as Array<{ id: string; text: string }>).map((m) => (
        <LazyMarkdown key={m.id} messageId={m.id} text={m.text} />
      ))}
    </LazyMarkdownProvider>
  )
}

describe('LazyMarkdown — troca de conversa progressiva', () => {
  it('ao abrir, só as últimas respostas viram Markdown; as de cima entram como texto e viram Markdown no ocioso', async () => {
    vi.useFakeTimers()
    const messages = answers(EAGER_ANSWERS + 4)
    const { container } = render(<Conversation messages={messages} />)
    expect(container.querySelectorAll('.md-plain')).toHaveLength(4)
    expect(container.querySelectorAll('strong')).toHaveLength(EAGER_ANSWERS)
    // O texto das de cima já está no DOM (Ctrl+F acha), só sem formatação.
    expect(container.querySelector('.md-plain')?.textContent).toBe('**Resposta 0** com *ênfase*')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(container.querySelectorAll('.md-plain')).toHaveLength(0)
    expect(container.querySelectorAll('strong')).toHaveLength(EAGER_ANSWERS + 4)
  })

  it('o que chega depois de aberta (streaming) e o texto ao vivo já entram em Markdown', () => {
    const messages = answers(EAGER_ANSWERS + 2)
    const { container, rerender } = render(<Conversation messages={messages} />)
    rerender(<Conversation messages={[...messages, ...answers(EAGER_ANSWERS + 3).slice(-1).map((m) => ({ ...m, id: 'nova' }) as UIMessage)]} />)
    const last = container.querySelectorAll('.md')
    expect(last[last.length - 1].classList.contains('md-plain')).toBe(false)
    const live = render(
      <LazyMarkdownProvider value={new Set(['vivo'])}>
        <LazyMarkdown messageId="vivo" text="**ao vivo**" blur />
      </LazyMarkdownProvider>
    )
    expect(live.container.querySelector('.md-plain')).toBeNull()
  })
})
