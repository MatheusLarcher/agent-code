import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { PoChatMessage } from '@shared/poChat'
import type { BoardItem } from '@shared/ipc'
import { PoChatPanel } from './PoChatPanel'
import { UiProvider } from '../ui/UiProvider'
import type { PoChatState } from './usePoChat'
import { usePoChat, type PoChatApi } from './usePoChat'
import { usePoChatPanel } from './usePoChatPanel'

/**
 * A tela do "Fala, PO": as bolhas com "Com base em …", os chips de fonte (a
 * conversa, o card com a miniatura do print), os botões do PO, as perguntas
 * prontas (com a do card selecionado) e o "Voltar".
 */

const NOW = Date.UTC(2026, 9, 7, 12, 0)

const history: PoChatMessage[] = [
  { id: 'u1', role: 'usuario', text: 'O que falta fazer?', at: NOW - 60_000 },
  {
    id: 'p1',
    role: 'po',
    text: 'A tela de login está pronta; falta a API.',
    at: NOW - 50_000,
    sources: [
      { kind: 'conversa', conversationId: 'conv-a', title: 'Implementação', at: NOW - 12 * 60_000 },
      { kind: 'quadro', at: NOW - 2 * 60_000 },
      { kind: 'card', cardId: 'card-login', conversationId: 'conv-a', title: 'Tela de login', thumbUrl: 'data:image/jpeg;base64,MINI' }
    ],
    unconfirmed: 'ninguém viu a tela no código',
    options: [
      { kind: 'verificar', minutes: 4, question: 'O que falta fazer?' },
      { kind: 'abrir-card', cardId: 'card-api', conversationId: 'conv-b', title: 'API de login' }
    ]
  }
]

function state(over: Partial<PoChatState> = {}): PoChatState {
  return { messages: history, asking: null, error: null, ask: vi.fn(), ...over }
}

function panel(over: Partial<Parameters<typeof PoChatPanel>[0]> = {}) {
  const props = {
    projectCwd: 'C:/loja',
    projectName: 'loja',
    state: state(),
    selectedCard: null,
    onBack: vi.fn(),
    onOpenConversation: vi.fn(),
    onOpenCard: vi.fn(),
    now: NOW,
    ...over
  }
  render(
    <UiProvider>
      <PoChatPanel {...props} />
    </UiProvider>
  )
  return props
}

afterEach(() => cleanup())

describe('PoChatPanel', () => {
  it('a resposta diz de onde veio; os chips abrem a conversa e o card (com a miniatura)', () => {
    const p = panel()
    expect(screen.getByText("Com base na última resposta do agente da conversa 'Implementação' (há 12 min) e no quadro (atualizado há 2 min).")).toBeTruthy()
    expect(screen.getByText('⚠ Não confirmado: ninguém viu a tela no código')).toBeTruthy()
    fireEvent.click(screen.getByTitle('Abrir a conversa'))
    expect(p.onOpenConversation).toHaveBeenCalledWith('conv-a')
    const card = screen.getByTitle('Abrir o card no quadro')
    expect(card.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,MINI')
    fireEvent.click(card)
    expect(p.onOpenCard).toHaveBeenCalledWith('card-login', 'conv-a')
  })

  it('as opções do PO viram botões: abrir o card; verificar só com quem verifique', () => {
    const onVerify = vi.fn()
    const p = panel({ onVerify })
    fireEvent.click(screen.getByRole('button', { name: "Abrir o card 'API de login'" }))
    expect(p.onOpenCard).toHaveBeenCalledWith('card-api', 'conv-b')
    fireEvent.click(screen.getByRole('button', { name: 'Verificar de verdade (~4 min)' }))
    expect(onVerify).toHaveBeenCalledWith({ kind: 'verificar', minutes: 4, question: 'O que falta fazer?' }, history[1])
  })

  it('perguntas prontas (com a do card selecionado) perguntam no clique; "Voltar" volta', () => {
    const s = state()
    const p = panel({ state: s, selectedCard: { id: 'k', title: 'Tela de login' } })
    for (const q of ['O que falta fazer?', 'O que está travado?', 'O que precisa de mim?', 'Resumo de hoje', 'Dá para commitar?']) {
      expect(screen.getAllByRole('button', { name: q }).length).toBeGreaterThan(0)
    }
    fireEvent.click(screen.getByRole('button', { name: "Como está 'Tela de login'?" }))
    expect(s.ask).toHaveBeenCalledWith("Como está 'Tela de login'?")
    fireEvent.click(screen.getByRole('button', { name: 'Voltar à conversa de antes' }))
    expect(p.onBack).toHaveBeenCalled()
  })

  it('pergunta em voo: a bolha do usuário e "o PO está olhando o quadro…"', () => {
    panel({ state: state({ messages: [], asking: 'Resumo de hoje' }) })
    expect(screen.getByText('Resumo de hoje', { selector: '.central-bubble' })).toBeTruthy()
    expect(screen.getByText('o PO está olhando o quadro…')).toBeTruthy()
  })
})

describe('o "Mandar fazer" na tela', () => {
  const proposal: PoChatMessage = {
    id: 'p2',
    role: 'po',
    text: 'Falta a API.',
    at: NOW,
    options: [
      {
        kind: 'mandar',
        conversationId: 'conv-b',
        conversationTitle: 'Backend',
        cardIds: ['k-api'],
        titles: ['API de login'],
        text: 'Pedido do PO, aprovado pelo usuário no "Fala, PO": termine estas tarefas do quadro deste projeto.\n\n- "API de login" (a fazer)'
      }
    ]
  }

  it('o clique na proposta só abre a prévia (com o texto exato); o "Mandar" é que manda', () => {
    const s = state({ messages: [proposal], send: vi.fn() })
    panel({ state: s, isLocalConversation: () => true })
    // A prévia abre no fim do feed: rola até ela, para os botões não ficarem cortados.
    const original = Element.prototype.scrollIntoView
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    try {
      fireEvent.click(screen.getByRole('button', { name: "Mandar o agente da conversa 'Backend' fazer: API de login" }))
    } finally {
      Element.prototype.scrollIntoView = original
    }
    expect(s.send).not.toHaveBeenCalled()
    const preview = screen.getByRole('group', { name: 'Prévia do pedido' })
    expect(scrolled.mock.contexts[0]).toBe(preview)
    expect(preview.textContent).toMatch(/Vai para a conversa 'Backend'/)
    expect(preview.querySelector('pre')?.textContent).toBe(proposal.options![0].kind === 'mandar' ? proposal.options![0].text : '')
    fireEvent.click(screen.getByRole('button', { name: 'Mandar' }))
    expect(s.send).toHaveBeenCalledWith('p2', 0)
  })

  it('conversa dona fora deste PC: a prévia avisa, e o "Mandar" cria a conversa nova e manda para ela', () => {
    const s = state({ messages: [proposal], send: vi.fn() })
    const createConversation = vi.fn(() => ({ id: 'conv-nova', title: 'Pedido do PO: API de login' }))
    panel({ state: s, isLocalConversation: () => false, createConversation })
    fireEvent.click(screen.getByRole('button', { name: "Mandar o agente da conversa 'Backend' fazer: API de login" }))
    expect(screen.getByRole('group', { name: 'Prévia do pedido' }).textContent).toMatch(/não está neste PC.*conversa nova de implementação/)
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('group', { name: 'Prévia do pedido' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: "Mandar o agente da conversa 'Backend' fazer: API de login" }))
    fireEvent.click(screen.getByRole('button', { name: 'Mandar' }))
    expect(createConversation).toHaveBeenCalledWith('Pedido do PO: API de login')
    expect(s.send).toHaveBeenCalledWith('p2', 0, { conversationId: 'conv-nova', conversationTitle: 'Pedido do PO: API de login' })
  })

  it('verificando: o tempo passa na bolha e o "Cancelar" cancela', () => {
    const s = state({ messages: history, verifying: { messageId: 'p1', startedAt: Date.now() - 80_000, minutes: 4 }, cancel: vi.fn(), verify: vi.fn() })
    panel({ state: s })
    expect(screen.getByRole('status').textContent).toMatch(/verificando… 1:2\d/)
    expect(screen.getByRole('button', { name: 'Verificar de verdade (~4 min)' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(s.cancel).toHaveBeenCalled()
  })
})

describe('usePoChat', () => {
  it('lê o histórico guardado do projeto e pergunta; a resposta troca a conversa', async () => {
    const api: PoChatApi = {
      poChatHistory: vi.fn(async () => ({ ok: true as const, messages: history.slice(0, 1) })),
      poChatAsk: vi.fn(async () => ({ ok: true as const, messages: history }))
    }
    const { result } = renderHook(() => usePoChat('C:/loja', api))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    act(() => result.current.ask('O que falta fazer?'))
    expect(result.current.asking).toBe('O que falta fazer?')
    await waitFor(() => expect(result.current.messages).toHaveLength(2))
    expect(result.current.asking).toBeNull()
    expect(api.poChatAsk).toHaveBeenCalledWith({ projectCwd: 'C:/loja', question: 'O que falta fazer?' })
  })
})

describe('usePoChatPanel', () => {
  it('abre no projeto ativo; fecha no "Voltar" e quando outra conversa vira a ativa', () => {
    ;(window as unknown as { api: unknown }).api = { poChatHistory: vi.fn(async () => ({ ok: true, messages: [] })), poChatAsk: vi.fn() }
    const { result, rerender } = renderHook((p: { activeId: string }) => usePoChatPanel({ projectCwd: 'C:/loja', activeId: p.activeId, openCard: vi.fn(), openConversation: vi.fn() }), {
      initialProps: { activeId: 'conv-a' }
    })
    expect(result.current.panel).toBeNull()
    act(() => result.current.open())
    expect(result.current.isOpen).toBe(true)
    act(() => result.current.onBoardSelect({ id: 'k', poTitle: null, sourceTitle: 'Tela de login' } as BoardItem))
    rerender({ activeId: 'conv-b' })
    expect(result.current.isOpen).toBe(false)
    act(() => result.current.open())
    act(() => result.current.close())
    expect(result.current.panel).toBeNull()
  })
})
