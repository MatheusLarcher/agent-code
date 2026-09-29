import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { UIMessage } from '../types'
import { UiProvider } from '../ui/UiProvider'
import { MessageList } from './MessageList'
import { useQuoteComments } from './quoteComment/useQuoteComments'
import { buildQuotedMessage } from './quoteComment/quoteFormat'

afterEach(cleanup)

// jsdom não implementa scrollIntoView — o MessageList chama isso ao montar.
Element.prototype.scrollIntoView = vi.fn()

const tts = { speakingId: null, onToggleSpeak: (): void => {} }
const BTN = 'Comentar este trecho'

const ANSWER: UIMessage = {
  kind: 'assistant-text',
  id: 'a1',
  text: 'Primeiro parágrafo da resposta.\n\nSegundo parágrafo, com **negrito**.',
  final: true,
  answer: true
}

/** A lista com o estado de verdade do "Comentar" (o mesmo hook do ChatPanel). */
function Harness({ messages }: { messages: UIMessage[] }): JSX.Element {
  const quote = useQuoteComments('c1', messages)
  return (
    <>
      <MessageList messages={messages} busy={false} tts={tts} onRetry={() => {}} quote={quote.list} />
      <output data-testid="chips">{quote.chips.map((c) => `${c.messageId}:${c.text}`).join('|')}</output>
    </>
  )
}

const renderList = (messages: UIMessage[]) =>
  render(
    <UiProvider>
      <Harness messages={messages} />
    </UiProvider>
  )

const paragraphs = (c: HTMLElement): HTMLElement[] => [...c.querySelectorAll<HTMLElement>('.msg.assistant .md > p')]

describe('MessageList — "Comentar" nos blocos da resposta do agente', () => {
  it('cada parágrafo do agente tem o botão (no hover/foco); a mensagem do usuário não tem', () => {
    const { container } = renderList([{ kind: 'user', id: 'u1', text: 'Explique.' }, ANSWER])
    const [first, second] = paragraphs(container)
    fireEvent.mouseOver(first)
    const btn = within(first).getByRole('button', { name: BTN })
    expect(btn.textContent).toContain('Comentar')
    expect(within(second).getByRole('button', { name: BTN })).toBeTruthy()
    expect(first.classList.contains('qc-block')).toBe(true)
    // Alcançável por teclado: um <button> de verdade, na ordem do Tab.
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.tabIndex).toBe(0)
    btn.focus()
    expect(document.activeElement).toBe(btn)
    // Só os blocos do agente.
    const user = container.querySelector('.msg.user') as HTMLElement
    expect(within(user).queryByRole('button', { name: BTN })).toBeNull()
    expect(screen.getAllByRole('button', { name: BTN })).toHaveLength(2)
  })

  it('item de lista, título e bloco de código também; item "solto" (com parágrafo) não duplica o botão', () => {
    const text = '# Título\n\n- item um\n- item dois\n\n```ts\nconst x = 1\n```\n\n1. solto\n\n2. outro solto'
    const { container } = renderList([{ ...ANSWER, text }])
    const md = container.querySelector('.msg.assistant .md') as HTMLElement
    expect(within(md.querySelector('h1')!).getByRole('button', { name: BTN })).toBeTruthy()
    const [um, dois] = md.querySelectorAll('ul > li')
    expect(within(um as HTMLElement).getByRole('button', { name: BTN })).toBeTruthy()
    expect(within(dois as HTMLElement).getByRole('button', { name: BTN })).toBeTruthy()
    const pre = md.querySelector('pre') as HTMLElement
    expect(pre.parentElement?.classList.contains('qc-pre')).toBe(true)
    expect(within(pre.parentElement!).getByRole('button', { name: BTN })).toBeTruthy()
    // "1. solto\n\n2. outro solto": o <li> tem <p> dentro — o botão fica só no parágrafo.
    const loose = md.querySelector('ol > li') as HTMLElement
    expect(loose.classList.contains('qc-block')).toBe(false)
    expect(within(loose.querySelector('p')!).getAllByRole('button', { name: BTN })).toHaveLength(1)
  })

  it('o clique põe o trecho literal (texto visível do bloco) num chip; o bloco fica destacado como pendente', () => {
    const { container } = renderList([ANSWER])
    const [, second] = paragraphs(container)
    fireEvent.click(within(second).getByRole('button', { name: BTN }))
    expect(screen.getByTestId('chips').textContent).toBe('a1:Segundo parágrafo, com negrito.')
    expect(paragraphs(container)[1].classList.contains('qc-pending')).toBe(true)
    expect(paragraphs(container)[0].classList.contains('qc-pending')).toBe(false)
  })

  it('o mesmo bloco duas vezes não duplica o chip e avisa por toast', () => {
    const { container } = renderList([ANSWER])
    const [first] = paragraphs(container)
    fireEvent.click(within(first).getByRole('button', { name: BTN }))
    fireEvent.click(within(first).getByRole('button', { name: BTN }))
    expect(screen.getByTestId('chips').textContent).toBe('a1:Primeiro parágrafo da resposta.')
    const toast = container.ownerDocument.querySelector('.toast.aviso')
    expect(toast?.textContent).toContain('já está citado')
  })

  it('bloco já comentado no histórico (mensagem do usuário com a citação) aparece destacado', () => {
    const reply: UIMessage = {
      kind: 'user',
      id: 'u2',
      text: buildQuotedMessage([{ messageId: 'a1', text: 'Segundo parágrafo, com negrito.' }], 'Por quê?')
    }
    const { container } = renderList([ANSWER, reply])
    const [first, second] = paragraphs(container)
    expect(second.classList.contains('qc-commented')).toBe(true)
    expect(first.classList.contains('qc-commented')).toBe(false)
    // Id de outra mensagem com o mesmo texto não marca este bloco.
    cleanup()
    const other = { ...reply, text: reply.text.replace('mensagem a1', 'mensagem a9') }
    const again = renderList([ANSWER, other])
    expect(paragraphs(again.container)[1].classList.contains('qc-commented')).toBe(false)
  })

  it('trecho que termina em "…" por conta própria só destaca o bloco igual, não o que começa igual', () => {
    const answer: UIMessage = { ...ANSWER, text: 'Aguarde…\n\nAguarde… o build termina em 2 minutos.' }
    const reply: UIMessage = { kind: 'user', id: 'u2', text: buildQuotedMessage([{ messageId: 'a1', text: 'Aguarde…' }], 'ok') }
    const { container } = renderList([answer, reply])
    const [short, long] = paragraphs(container)
    expect(short.classList.contains('qc-commented')).toBe(true)
    expect(long.classList.contains('qc-commented')).toBe(false)
  })

  it('mensagem com envio falho ou cancelado não marca o bloco como comentado', () => {
    const quoted = buildQuotedMessage([{ messageId: 'a1', text: 'Segundo parágrafo, com negrito.' }], 'Por quê?')
    for (const failed of [
      { kind: 'user', id: 'u2', text: quoted, error: 'Falha na sessão' },
      { kind: 'user', id: 'u2', text: quoted, canceled: true }
    ] satisfies UIMessage[]) {
      const { container } = renderList([ANSWER, failed])
      expect(paragraphs(container)[1].classList.contains('qc-commented')).toBe(false)
      cleanup()
    }
  })

  it('sem o `quote` (a lista fora do ChatPanel), a resposta sai como sempre: sem botão nem destaque', () => {
    const { container } = render(
      <UiProvider>
        <MessageList messages={[ANSWER]} busy={false} tts={tts} onRetry={() => {}} />
      </UiProvider>
    )
    expect(screen.queryByRole('button', { name: BTN })).toBeNull()
    expect(container.querySelector('.qc-block')).toBeNull()
    expect(paragraphs(container).map((p) => p.textContent)).toEqual([
      'Primeiro parágrafo da resposta.',
      'Segundo parágrafo, com negrito.'
    ])
  })
})

describe('quoteComment.css — o botão é discreto: só no hover e no foco', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/quoteComment/quoteComment.css'), 'utf8')
  // A última regra daquele seletor: a própria dele vem depois da lista "a,\nb {" que o repete.
  const block = (selector: string): string => {
    const start = css.lastIndexOf(`\n${selector} {`)
    expect(start, selector).toBeGreaterThan(-1)
    return css.slice(start, css.indexOf('}', start))
  }

  it('escondido por opacidade (continua focável), aparece no :hover e no :focus-within do bloco', () => {
    const btn = block('.qc-btn')
    expect(btn).toMatch(/opacity: 0;/)
    expect(btn).not.toMatch(/display: none|visibility: hidden/)
    expect(css).toMatch(/\.qc-block:hover:not\(:has\(\.qc-block:hover\)\) > \.qc-btn,/)
    expect(css).toMatch(/\.qc-block:focus-within:not\(:has\(\.qc-block:focus-within\)\) > \.qc-btn \{\s*opacity: 1;/)
  })

  it('pendente e comentado têm destaque próprio', () => {
    expect(block('.qc-block.qc-pending')).toMatch(/border-left-color: var\(--accent\);/)
    expect(block('.qc-block.qc-commented')).toMatch(/border-left-color:/)
  })
})
