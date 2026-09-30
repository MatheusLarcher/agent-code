import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { UIMessage } from '../../types'
import { UiProvider } from '../../ui/UiProvider'
import { MessageList } from '../MessageList'
import { useQuoteComments } from './useQuoteComments'
import { findBlockStart, readFromText } from './readFrom'

afterEach(cleanup)
Element.prototype.scrollIntoView = vi.fn()

const TEXT = '# Plano\n\nPrimeiro parágrafo.\n\n- item **um**\n- item dois\n\nÚltimo parágrafo, fim.'
const ANSWER: UIMessage = { kind: 'assistant-text', id: 'a1', text: TEXT, final: true, answer: true }

describe('readFrom — localiza o bloco no texto-fonte', () => {
  it('do bloco até o fim, mesmo com marcação no meio', () => {
    expect(readFromText(TEXT, 'item um').text).toBe('- item **um**\n- item dois\n\nÚltimo parágrafo, fim.')
    expect(readFromText(TEXT, 'Plano').text).toBe(TEXT)
  })
  it('bloco de código sobe para a cerca', () => {
    const src = 'Antes.\n\n```ts\nconst x = 1\n```\n\nDepois.'
    expect(readFromText(src, 'const x = 1\n').text).toBe('```ts\nconst x = 1\n```\n\nDepois.')
  })
  it('não achou: só o bloco', () => {
    expect(findBlockStart(TEXT, 'inexistente aqui')).toBe(-1)
    expect(readFromText(TEXT, 'inexistente aqui').text).toBe('inexistente aqui')
  })
})

function Harness({ speakingId, onToggleSpeak }: { speakingId: string | null; onToggleSpeak: (id: string, t: string) => void }): JSX.Element {
  const quote = useQuoteComments([ANSWER])
  return <MessageList messages={[ANSWER]} busy={false} tts={{ speakingId, onToggleSpeak }} onRetry={() => {}} quote={quote.list} />
}

describe('"Ler daqui" nos blocos', () => {
  it('aparece ao lado de Comentar e chama o TTS da mensagem do bloco até o fim', () => {
    const onToggleSpeak = vi.fn()
    const { container, rerender } = render(<UiProvider><Harness speakingId={null} onToggleSpeak={onToggleSpeak} /></UiProvider>)
    const li = container.querySelector('.msg.assistant .md li') as HTMLElement
    fireEvent.mouseOver(li)
    const btn = within(li).getByRole('button', { name: 'Ler daqui' })
    expect(btn.parentElement?.classList.contains('qc-actions')).toBe(true)
    expect(within(li).getByRole('button', { name: 'Comentar este trecho' })).toBeTruthy()
    expect(btn.tabIndex).toBe(0)
    fireEvent.click(btn)
    expect(onToggleSpeak).toHaveBeenCalledTimes(1)
    const [id, text] = onToggleSpeak.mock.calls[0]
    expect(text).toBe('- item **um**\n- item dois\n\nÚltimo parágrafo, fim.')
    expect(id).toMatch(/^a1#ler:/)
    // Tocando: o botão do bloco vira "Parar"; outro clique chama o toggle com o mesmo id (para).
    rerender(<UiProvider><Harness speakingId={id} onToggleSpeak={onToggleSpeak} /></UiProvider>)
    const stop = within(li).getByRole('button', { name: 'Parar leitura' })
    fireEvent.click(stop)
    expect(onToggleSpeak.mock.calls[1][0]).toBe(id)
    // Os outros blocos seguem "Ler daqui".
    expect(screen.getAllByRole('button', { name: 'Parar leitura' })).toHaveLength(1)
  })

  it('narração (sem botão Ouvir na mensagem) não ganha "Ler daqui"; Comentar continua', () => {
    const narr: UIMessage = { kind: 'assistant-text', id: 'n1', text: 'Vou ler o arquivo.', final: true }
    function N(): JSX.Element {
      const quote = useQuoteComments([narr])
      return <MessageList messages={[narr]} busy={false} tts={{ speakingId: null, onToggleSpeak: vi.fn() }} onRetry={() => {}} quote={quote.list} />
    }
    const { container } = render(<UiProvider><N /></UiProvider>)
    const p = container.querySelector('.msg.assistant .md p') as HTMLElement
    expect(within(p).queryByRole('button', { name: 'Ler daqui' })).toBeNull()
    expect(within(p).getByRole('button', { name: 'Comentar este trecho' })).toBeTruthy()
  })
})
