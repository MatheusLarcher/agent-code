/**
 * As animações do chat só tocam no que chegou AO VIVO: o histórico ao abrir a
 * conversa (ou trocar de conversa) entra pronto; a mensagem nova entra palavra a
 * palavra (BlurText) e os contadores sobem (CountUp). O texto continua o mesmo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { UIMessage } from '../types'
import { UiProvider } from '../ui/UiProvider'
import { MessageList } from '../components/MessageList'
import { resetStepOpen } from '../components/useStepOpen'
import { CountUp } from './CountUp'

const tts = { speakingId: null, onToggleSpeak: () => {} }
const say = (id: string, text: string): UIMessage => ({ kind: 'assistant-text', id, text, final: true }) as UIMessage
const tool = (id: string, name: string, input: unknown): UIMessage =>
  ({ kind: 'tool-use', id, name, input, parentToolUseId: null, result: { isError: false, text: 'ok' } }) as UIMessage

function list(messages: UIMessage[], busy = false): JSX.Element {
  return (
    <UiProvider>
      <MessageList messages={messages} busy={busy} tts={tts} onRetry={() => {}} />
    </UiProvider>
  )
}

const history: UIMessage[] = [{ kind: 'user', id: 'u1', text: 'oi' } as UIMessage, say('a1', 'Texto antigo da conversa.'), tool('g1', 'Grep', { pattern: 'x' })]

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  resetStepOpen()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-07T10:00:00Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('chatAnim — só o que chega ao vivo anima', () => {
  it('histórico ao abrir não anima; a narração nova entra palavra a palavra, com o mesmo texto', () => {
    const view = render(list(history))
    expect(view.container.querySelector('.ca-w, .ca-pop')).toBeNull()
    vi.setSystemTime(new Date('2026-10-07T10:00:05Z'))
    view.rerender(list([...history, say('a2', 'Achei **a causa** agora.')]))
    const step = view.container.querySelector<HTMLElement>('[data-step-id="a2"]')!
    expect(step.classList.contains('ca-pop')).toBe(true)
    const words = [...step.querySelectorAll<HTMLElement>('.ca-w')]
    expect(words.map((w) => w.textContent)).toEqual(['Achei', 'a', 'causa', 'agora.'])
    expect(words[3].style.getPropertyValue('--i')).toBe('3')
    expect(step.querySelector('.md')?.textContent).toBe('Achei a causa agora.')
    // O antigo continua sem animação.
    expect(view.container.querySelector('[data-step-id="a1"] .ca-w')).toBeNull()
  })

  it('streaming: o pedaço novo conta o atraso a partir do que já estava na tela', () => {
    const view = render(list(history))
    vi.setSystemTime(new Date('2026-10-07T10:00:05Z'))
    view.rerender(list([...history, say('a2', 'um dois')]))
    view.rerender(list([...history, say('a2', 'um dois tres quatro')]))
    const words = [...view.container.querySelectorAll<HTMLElement>('[data-step-id="a2"] .ca-w')]
    expect(words.map((w) => w.style.getPropertyValue('--i'))).toEqual(['0', '0', '0', '1'])
  })

  it('trocar de conversa (outra 1ª mensagem) é histórico: nada anima', () => {
    const view = render(list(history))
    vi.setSystemTime(new Date('2026-10-07T10:00:05Z'))
    view.rerender(list([{ kind: 'user', id: 'u9', text: 'outra' } as UIMessage, say('b1', 'Outra conversa.')]))
    expect(view.container.querySelector('.ca-w, .ca-pop')).toBeNull()
  })

  it('CountUp: sem animar é só o número; animando sobe de 0 até o valor', () => {
    const still = render(<CountUp value={7} animate={false} />)
    expect(still.container.textContent).toBe('7')
    still.unmount()
    vi.useRealTimers()
    let now = 0
    const frames: FrameRequestCallback[] = []
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb))
    const live = render(<CountUp value={45} animate />)
    expect(live.container.textContent).toBe('0')
    now = 700
    act(() => frames.splice(0).forEach((cb) => cb(now)))
    expect(live.container.textContent).toBe('45')
  })
})
