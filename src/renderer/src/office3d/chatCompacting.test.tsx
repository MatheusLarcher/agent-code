/**
 * O aviso de compactação e o loading no chat do Escritório 3D: o feed traz o
 * início da compactação por conversa; só o agente principal o mostra (a trilha
 * do subagente não), e a tela do chat troca a linha ao vivo pelo aviso.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { conv, feed, NOW } from '../office/adapter/testFeed'
import type { UIMessage } from '../types'
import { UiProvider } from '../ui/UiProvider'
import { ChatPanel, chatContent } from './ChatScreen'

afterEach(() => cleanup())

const ask: UIMessage = { kind: 'user', id: 'u1', text: 'Roda os testes', ts: NOW - 60_000 } as UIMessage
const principal = { key: 'c1', convId: 'c1', role: 'principal' } as unknown as OfficeCharacterModel
const sub = { key: 'c1:t1', convId: 'c1', role: 'executor', trackId: 't1' } as unknown as OfficeCharacterModel

describe('Escritório — compactação no chat', () => {
  const f = feed({ conversations: [conv('c1', { messages: [ask] })], busyIds: new Set(['c1']), compactingSince: { c1: NOW - 3000 } })

  it('chatContent: o principal recebe o início da compactação; o subagente, não; sem compactar, nada muda', () => {
    expect(chatContent(f, principal, undefined).compactingSince).toBe(NOW - 3000)
    expect(chatContent(f, sub, undefined)).not.toHaveProperty('compactingSince')
    expect(chatContent(feed({ conversations: [conv('c1', { messages: [ask] })] }), principal, undefined)).not.toHaveProperty('compactingSince')
  })

  it('a tela do chat mostra "Compactando a conversa…" com o loading no modo compactar', () => {
    const head = { title: 'c1', who: 'alpha', busy: true }
    const { container, rerender } = render(
      <UiProvider>
        <ChatPanel head={head} color="#d97757" content={chatContent(f, principal, undefined)} />
      </UiProvider>
    )
    const live = container.querySelector('.chat-live.compacting')!
    expect(live.querySelector('.chat-live-text')?.textContent).toBe('Compactando a conversa…')
    expect(live.querySelector('.chat-live-loader.compacting')).toBeTruthy()
    // Fim da compactação: volta a linha normal, com o loading de sempre.
    rerender(
      <UiProvider>
        <ChatPanel head={head} color="#d97757" content={{ messages: [ask], live: null }} />
      </UiProvider>
    )
    expect(container.querySelector('.chat-live.compacting')).toBeNull()
    expect(container.querySelector('.chat-live .chat-live-loader:not(.compacting)')).toBeTruthy()
  })
})
