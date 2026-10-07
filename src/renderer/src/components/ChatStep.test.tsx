/**
 * O chat resumido na conversa do PC (MessageList → ChatStepRow): linha-resumo
 * recolhida por resposta, o clique abre só os cartões dela, "agora: …" girando
 * no turno em andamento, resposta final inteira com "Ouvir" e a paginação
 * contando LINHAS (a resposta inteira conta uma).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { UIMessage } from '../types'
import { UiProvider } from '../ui/UiProvider'
import { MessageList } from './MessageList'
import { resetStepOpen } from './useStepOpen'

const tts = { speakingId: null, onToggleSpeak: () => {} }
const say = (id: string, text: string, answer = false): UIMessage => ({ kind: 'assistant-text', id, text, final: true, ...(answer ? { answer: true } : {}) }) as UIMessage
const tool = (id: string, name: string, input: unknown, done = true): UIMessage =>
  ({ kind: 'tool-use', id, name, input, parentToolUseId: null, ...(done ? { result: { isError: false, text: 'ok' } } : {}) }) as UIMessage

function renderList(messages: UIMessage[], busy = false) {
  const view = render(
    <UiProvider>
      <MessageList messages={messages} busy={busy} tts={tts} onRetry={() => {}} />
    </UiProvider>
  )
  const rerender = (next: UIMessage[], nextBusy = busy): void =>
    view.rerender(
      <UiProvider>
        <MessageList messages={next} busy={nextBusy} tts={tts} onRetry={() => {}} />
      </UiProvider>
    )
  return { ...view, rerender }
}

const turn: UIMessage[] = [
  { kind: 'user', id: 'u1', text: 'Corrige o Enviar' } as UIMessage,
  say('a1', 'Vou procurar o campo.'),
  tool('g', 'Grep', { pattern: 'send-btn' }),
  tool('r1', 'Read', { file_path: '/p/Composer.tsx' }),
  say('a2', 'Achei a causa.'),
  tool('e', 'Edit', { file_path: '/p/Composer.tsx', old_string: 'a', new_string: 'b\nc' }),
  say('a3', 'Pronto: o Enviar funciona.', true)
]

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  resetStepOpen()
})
afterEach(() => cleanup())

describe('MessageList — resumo por resposta', () => {
  it('cada texto com a sua linha recolhida; o clique abre só os cartões daquela resposta; outro clique fecha', () => {
    const { container } = renderList(turn)
    const steps = [...container.querySelectorAll<HTMLElement>('.chat-step')]
    expect(steps).toHaveLength(3)
    expect(container.querySelector('.tool-card')).toBeNull()
    const [first, second, final] = steps
    expect(first.querySelector('.msg.assistant.narration')?.textContent).toContain('Vou procurar o campo.')
    expect(first.querySelector('.central-sum')?.textContent).toBe('Procurou "send-btn" · leu Composer.tsx')
    expect(first.querySelector('.central-count')?.textContent).toBe('2 ações')
    expect(second.querySelector('.central-sum')?.textContent).toBe('Editou Composer.tsx +2 −1')
    // Resposta final inteira, sem linha-resumo.
    expect(final.querySelector('.central-act')).toBeNull()
    expect(final.textContent).toContain('Pronto: o Enviar funciona.')

    fireEvent.click(second.querySelector('.central-act')!)
    expect([...container.querySelectorAll('.tool-card .tool-name')].map((n) => n.textContent)).toEqual(['Edit'])
    expect(second.querySelector('.central-act')?.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(second.querySelector('.central-act')!)
    expect(container.querySelector('.tool-card')).toBeNull()
  })

  it('em andamento: a última resposta gira com "agora: …"; o aberto continua aberto quando chegam mensagens', () => {
    const running = [...turn.slice(0, 5), tool('e', 'Edit', { file_path: '/p/Composer.tsx', old_string: 'a', new_string: 'b' }, false)]
    const { container, rerender } = renderList(running, true)
    const last = [...container.querySelectorAll<HTMLElement>('.chat-step')].at(-1)!
    expect(last.querySelector('.central-act.running .central-spin')).toBeTruthy()
    expect(last.querySelector('.central-sum')?.textContent).toBe('agora: editando Composer.tsx…')
    fireEvent.click(container.querySelector('.chat-step .central-act')!)
    expect(container.querySelectorAll('.tool-card')).toHaveLength(2)
    rerender([...running.slice(0, 5), tool('e', 'Edit', { file_path: '/p/Composer.tsx', old_string: 'a', new_string: 'b' }), say('a3', 'Pronto.', true)], false)
    expect(container.querySelectorAll('.tool-card')).toHaveLength(2) // a 1ª resposta segue aberta
    expect(container.querySelector('.central-act.running')).toBeNull()
  })

  it('paginação conta LINHAS: 60 respostas de 3 ferramentas desenham 40 linhas, com o aviso das anteriores', () => {
    const msgs: UIMessage[] = [{ kind: 'user', id: 'u1', text: 'muitas' } as UIMessage]
    for (let i = 0; i < 60; i++) {
      msgs.push(say(`a${i}`, `passo ${i}`), tool(`t${i}a`, 'Read', { file_path: `/p/${i}a.ts` }), tool(`t${i}b`, 'Read', { file_path: `/p/${i}b.ts` }), tool(`t${i}c`, 'Bash', { command: 'ls' }))
    }
    const { container } = renderList(msgs)
    const rows = container.querySelectorAll('.message-list > .chat-step, .message-list > .msg')
    expect(rows).toHaveLength(40)
    // 61 linhas (pedido + 60 respostas) − 40 = 21 anteriores; a 1ª linha à vista é uma resposta inteira.
    expect(container.querySelector('.load-more-hint')?.textContent).toBe('↑ Role para cima para carregar mais (21 anteriores)')
    expect(container.querySelector('.message-list > .chat-step')?.textContent).toContain('passo 20')
    expect(container.querySelector('.message-list > .chat-step .central-count')?.textContent).toBe('3 ações')
  })
})
