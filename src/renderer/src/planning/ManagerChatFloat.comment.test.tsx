import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRef, Fragment, StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { UIMessage } from '../types'
import { ChatPanel } from '../components/ChatPanel'
import type { SendFn } from '../components/quoteComment/useQuoteComments'
import { UiProvider } from '../ui/UiProvider'
import { ManagerChatFloat } from './ManagerChatFloat'

/**
 * "Comentar" no Agent Manager minimizado: trecho citado ("[trecho N]" inline)
 * sem texto digitado já dá para enviar (o Enter envia), então a caixa NÃO pode
 * virar a faixa pequena sem botões (`composer-small`) — o enviar tem de estar à
 * vista. O Composer conta o trecho no `onHasTextChange`. Estilo COMPUTADO com o
 * planningChat.css real, como no ManagerChatFloat.small.test.
 */

const MESSAGES: UIMessage[] = [
  { kind: 'user', id: 'u1', text: 'Explique o plano.' },
  { kind: 'assistant-text', id: 'a1', text: 'Primeiro parágrafo.\n\nSegundo parágrafo.', final: true, answer: true }
]

let style: HTMLStyleElement
const onToggleSpeak = vi.fn()
beforeEach(() => {
  onToggleSpeak.mockClear()
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  ;(window as unknown as { api: unknown }).api = { mentionSearch: vi.fn(async () => []) }
  style = document.createElement('style')
  style.textContent = readFileSync(resolve(process.cwd(), 'src/renderer/src/planning/planningChat.css'), 'utf8')
  document.head.appendChild(style)
})
afterEach(() => {
  cleanup()
  style.remove()
  localStorage.clear()
})

function renderChat(opts: { strict?: boolean } = {}) {
  const onSend = vi.fn<SendFn>()
  // O app monta dentro de <React.StrictMode> (main.tsx).
  const Wrap = opts.strict ? StrictMode : Fragment
  const view = render(
    <Wrap>
      <UiProvider>
        <div className="pl-main">
          <ManagerChatFloat>
            <ChatPanel
              messages={MESSAGES}
              hasActive
              busy={false}
              windowsControlEnabled={false}
              onDisableWindowsControl={() => {}}
              tokens={{ context: 0, output: 0, cost: 0 }}
              chips={[]}
              onRemoveChip={() => {}}
              onSend={onSend}
              onInterrupt={() => {}}
              onRetry={() => {}}
              composerRef={createRef()}
              projects={[]}
              projectRoot={null}
              convId="c1"
              draft=""
              onDraftChange={() => {}}
              projectMissing={false}
              projectMissingMsg=""
              queued={[]}
              onDeleteQueued={() => {}}
              onRetryRecovery={() => {}}
              onCancelRecovery={() => {}}
              runningSince={null}
              lastDurationMs={null}
              voiceReady={false}
              onNeedVoiceKey={() => {}}
              tts={{ speakingId: null, onToggleSpeak }}
              models={[{ id: 'claude-opus-5-5', label: 'Opus 5.5' }]}
              model="claude-opus-5-5"
              runningModel="claude-opus-5-5"
              modelLocked={false}
              onModelChange={() => {}}
              onModelLockedClick={() => {}}
              effortLevels={[]}
              effort="high"
              effortLocked={false}
              onEffortChange={() => {}}
              economyMode={false}
              onEconomyModeChange={() => {}}
              loopEnabled={false}
              loopLocked={false}
              onLoopEnabledChange={() => {}}
              fastModeAvailable={false}
              fastMode={false}
              onFastModeChange={() => {}}
              pendingQuestion={false}
              onReopenQuestion={() => {}}
            />
          </ManagerChatFloat>
        </div>
      </UiProvider>
    </Wrap>
  )
  const panel = (): HTMLElement => screen.getByRole('region', { name: 'Agent Manager' })
  const c = view.container
  return {
    onSend,
    panel,
    box: (): HTMLElement => screen.getByRole('textbox', { name: 'Mensagem' }),
    small: (): boolean => panel().classList.contains('composer-small'),
    minimized: (): boolean => panel().classList.contains('minimized'),
    sendBtn: (): Element | null => c.querySelector('.composer-row .btn.send'),
    /** Trechos no campo: os anexos inline "[trecho N]" (o espelho atrás do campo tem cópias invisíveis). */
    chips: (): number => c.querySelectorAll('.composer [role="textbox"] img.inline-att-quote').length,
    /** Tira o trecho do texto (o que o Backspace/Delete faz com o <img>). */
    removeQuote: (): void => {
      act(() => {
        c.querySelector('.composer [role="textbox"] img.inline-att-quote')!.remove()
        screen.getByRole('textbox', { name: 'Mensagem' }).dispatchEvent(new Event('input', { bubbles: true }))
      })
    },
    /** "Comentar" no parágrafo `i` da resposta. */
    comment: (i: number): void => {
      const p = c.querySelectorAll<HTMLElement>('.msg.assistant .md > p')[i]
      fireEvent.click(within(p).getByRole('button', { name: 'Comentar este trecho' }))
    },
    /** Minimiza pela seta — o mesmo que clicar no canvas atrás do chat. */
    minimize: (): void => {
      fireEvent.click(screen.getByRole('button', { name: 'Minimizar o chat do Agent Manager' }))
    }
  }
}

/** Visível: nenhum ancestral com display:none (o CSS real está no documento). */
const shown = (el: Element | null): boolean => {
  if (!el) return false
  for (let x: Element | null = el; x; x = x.parentElement) if (getComputedStyle(x).display === 'none') return false
  return true
}

describe('Agent Manager minimizado com chip de citação e sem texto', () => {
  it('a caixa não vira a faixa pequena e o botão de enviar fica à vista', () => {
    const chat = renderChat()
    chat.minimize()
    // Sem chip e sem texto: a faixa pequena, sem o enviar (como sempre).
    expect(chat.small()).toBe(true)
    expect(shown(chat.sendBtn())).toBe(false)
    // Comentar um trecho (o clique no painel minimizado também o abre) e minimizar de novo.
    chat.comment(0)
    expect(chat.chips()).toBe(1)
    if (!chat.minimized()) chat.minimize()
    expect(chat.minimized()).toBe(true)
    expect(chat.small()).toBe(false)
    expect(shown(chat.sendBtn())).toBe(true)
  })

  it('o Enter envia só o trecho; sem chip de novo, a caixa volta a ser a faixa pequena', () => {
    const chat = renderChat()
    chat.comment(1)
    chat.minimize()
    expect(chat.small()).toBe(false)
    fireEvent.keyDown(chat.box(), { key: 'Enter' })
    expect(chat.onSend).toHaveBeenCalledTimes(1)
    expect(chat.onSend.mock.calls[0][0]).toBe('> [trecho 1] · mensagem a1\n> Segundo parágrafo.\n\n[trecho 1]')
    expect(chat.chips()).toBe(0)
    expect(chat.minimized()).toBe(true)
    expect(chat.small()).toBe(true)
    expect(shown(chat.sendBtn())).toBe(false)
  })

  it('tirar o trecho do texto, sem outro texto, devolve a faixa pequena', () => {
    const chat = renderChat()
    chat.comment(0)
    expect(chat.chips()).toBe(1)
    chat.removeQuote()
    expect(chat.chips()).toBe(0)
    chat.minimize()
    expect(chat.small()).toBe(true)
  })

  it('"Ler daqui" no chat do planejamento lê do bloco até o fim', () => {
    const { panel } = renderChat()
    const p = panel().querySelectorAll<HTMLElement>('.msg.assistant .md > p')[1]
    fireEvent.click(within(p).getByRole('button', { name: 'Ler daqui' }))
    expect(onToggleSpeak).toHaveBeenCalledTimes(1)
    expect(onToggleSpeak.mock.calls[0][1]).toBe('Segundo parágrafo.')
  })

  it('StrictMode: o chip também tira a faixa pequena', () => {
    const chat = renderChat({ strict: true })
    chat.comment(0)
    chat.minimize()
    expect(chat.small()).toBe(false)
    expect(shown(chat.sendBtn())).toBe(true)
  })
})
