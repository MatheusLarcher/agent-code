import { createRef, type ComponentProps, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PlanningCardDto } from '@shared/ipc'
import type { UIMessage } from '../types'
import { UiProvider } from '../ui/UiProvider'
import { ManagerChatFloat } from '../planning/ManagerChatFloat'
import { ChatPanel } from './ChatPanel'
import { QUOTE_MAX_CHARS } from './quoteComment/quoteFormat'
import type { SendFn } from './quoteComment/useQuoteComments'
import type { EditorElement } from '../inlineMedia/InlineEditor'
import { TOKEN } from '../inlineMedia/editorModel'

/**
 * "Comentar": o trecho entra como anexo INLINE ("[trecho N]") no cursor do campo
 * de mensagem — o mesmo mecanismo da imagem — e, no envio, as citações vão na
 * frente e o texto do usuário mantém o "[trecho N]" onde o anexo estava.
 */

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = { mentionSearch: vi.fn(async () => []) }
})
afterEach(() => {
  cleanup()
  localStorage.clear()
})

// jsdom não implementa scrollIntoView — o MessageList chama isso ao montar.
Element.prototype.scrollIntoView = vi.fn()

const BTN = 'Comentar este trecho'
const LONG_CODE = Array.from({ length: 80 }, (_, i) => `linha ${i} do código`).join('\n')
const MESSAGES: UIMessage[] = [
  { kind: 'user', id: 'u1', text: 'Explique o plano.' },
  {
    kind: 'assistant-text',
    id: 'a1',
    text: `Primeiro parágrafo.\n\n- item da lista\n\n\`\`\`\n${LONG_CODE}\n\`\`\``,
    final: true,
    answer: true
  },
  { kind: 'assistant-text', id: 'a2', text: 'Outra resposta, de outra mensagem.', final: true, answer: true }
]

type PanelProps = ComponentProps<typeof ChatPanel>

function panel(overrides: Partial<PanelProps>): JSX.Element {
  return (
    <ChatPanel
      messages={MESSAGES}
      hasActive
      busy={false}
      windowsControlEnabled={false}
      onDisableWindowsControl={() => {}}
      tokens={{ context: 0, output: 0, cost: 0 }}
      chips={[]}
      onRemoveChip={() => {}}
      onSend={() => {}}
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
      tts={{ speakingId: null, onToggleSpeak: () => {} }}
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
      {...overrides}
    />
  )
}

function renderPanel(overrides: Partial<PanelProps> = {}, wrap: (p: ReactNode) => ReactNode = (p) => p) {
  const onSend = vi.fn<SendFn>()
  const onDraftChange = vi.fn<PanelProps['onDraftChange']>()
  const composerRef = createRef<HTMLElement | null>()
  const all = { onSend, onDraftChange, composerRef, ...overrides }
  const view = render(<UiProvider>{wrap(panel(all))}</UiProvider>)
  const rerender = (next: Partial<PanelProps>): void => view.rerender(<UiProvider>{wrap(panel({ ...all, ...next }))}</UiProvider>)
  return { ...view, onSend, onDraftChange, composerRef, rerender }
}

const box = (): EditorElement => screen.getByPlaceholderText(/Mensagem para o Claude/) as EditorElement
const answer = (c: HTMLElement, id: string): HTMLElement =>
  [...c.querySelectorAll<HTMLElement>('.msg.assistant')].find((m) => m.textContent?.includes(id === 'a1' ? 'Primeiro' : 'Outra'))!
const firstP = (c: HTMLElement): HTMLElement => answer(c, 'a1').querySelector('.md > p')!
const otherP = (c: HTMLElement): HTMLElement => answer(c, 'a2').querySelector('.md > p')!
const commentOn = (block: Element): void => {
  fireEvent.click(within(block as HTMLElement).getByRole('button', { name: BTN }))
}
/** Os trechos no campo (os <img> inline), na ordem do texto, pelo texto acessível. */
const tokens = (): string[] => [...box().querySelectorAll('img.inline-att-quote')].map((i) => i.getAttribute('alt') ?? '')
/** Troca o texto do campo (TOKEN = o anexo que já está lá, na mesma ordem). */
const type = (value: string): void => {
  fireEvent.change(box(), { target: { value } })
}
const caretAt = (pos: number): void => {
  act(() => {
    box().focus()
    box().setSelectionRange(pos, pos)
  })
}
const send = (): void => {
  fireEvent.keyDown(box(), { key: 'Enter' })
}

const P1 = '> [trecho 1] · mensagem a1\n> Primeiro parágrafo.'

describe('ChatPanel — "Comentar" põe o trecho inline no campo (chat principal)', () => {
  it('o clique insere o anexo "[trecho 1]" DENTRO do texto (sem fileira de chips) e leva o foco ao campo', () => {
    const { container, composerRef } = renderPanel()
    commentOn(firstP(container))
    expect(tokens()).toEqual(['Trecho citado 1: Primeiro parágrafo.'])
    const img = box().querySelector('img.inline-att-quote')!
    expect(img.closest('[role="textbox"]')).toBe(box())
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    expect(decodeURIComponent(img.getAttribute('src')!)).toContain('[trecho 1]')
    expect(container.querySelector('.qc-chips, .qc-chip')).toBeNull()
    expect(document.activeElement).toBe(composerRef.current)
  })

  it('com o foco no campo, entra no ponto do cursor; o texto final tem a citação no topo e o "[trecho 1]" ali', () => {
    const { container, onSend } = renderPanel()
    type('antes  depois')
    caretAt(6)
    commentOn(firstP(container))
    expect(box().value).toBe(`antes ${TOKEN} depois`)
    send()
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0]).toBe(`${P1}\n\nantes [trecho 1] depois`)
  })

  it('sem o foco no campo, entra no fim do texto', () => {
    const { container, onSend } = renderPanel()
    type('olha isto: ')
    act(() => box().blur())
    commentOn(firstP(container))
    expect(box().value).toBe(`olha isto: ${TOKEN}`)
    send()
    expect(onSend.mock.calls[0][0]).toBe(`${P1}\n\nolha isto: [trecho 1]`)
  })

  it('dois trechos intercalados com o texto: citações numeradas primeiro, o texto com cada "[trecho N]" no lugar', () => {
    const { container, onSend } = renderPanel()
    type('comentario ')
    caretAt(11)
    commentOn(firstP(container))
    type(`comentario ${TOKEN} do usuario.\ncomentario `)
    caretAt(box().value.length)
    commentOn(otherP(container))
    type(`comentario ${TOKEN} do usuario.\ncomentario ${TOKEN} do usuario.`)
    expect(tokens()).toEqual(['Trecho citado 1: Primeiro parágrafo.', 'Trecho citado 2: Outra resposta, de outra mensagem.'])
    send()
    expect(onSend.mock.calls[0][0]).toBe(
      [
        '> [trecho 1] · mensagem a1',
        '> Primeiro parágrafo.',
        '',
        '> [trecho 2] · mensagem a2',
        '> Outra resposta, de outra mensagem.',
        '',
        'comentario [trecho 1] do usuario.',
        'comentario [trecho 2] do usuario.'
      ].join('\n')
    )
    // Enviado: o campo esvazia e o destaque de pendente sai.
    expect(box().querySelector('img')).toBeNull()
    expect(container.querySelector('.qc-pending')).toBeNull()
  })

  it('N segue a ordem no texto: o trecho inserido ANTES do outro vira o 1 (e o outro é renumerado)', () => {
    const { container, onSend } = renderPanel()
    type('fim')
    act(() => box().blur())
    commentOn(otherP(container)) // no fim: "fim[a2]"
    caretAt(0)
    commentOn(firstP(container)) // no começo: "[a1]fim[a2]"
    expect(tokens()).toEqual(['Trecho citado 1: Primeiro parágrafo.', 'Trecho citado 2: Outra resposta, de outra mensagem.'])
    send()
    expect(onSend.mock.calls[0][0]).toBe(
      `${P1}\n\n> [trecho 2] · mensagem a2\n> Outra resposta, de outra mensagem.\n\n[trecho 1]fim[trecho 2]`
    )
  })

  it('removível como a imagem: apagar o anexo do texto tira o trecho do envio e o destaque pendente', () => {
    const { container, onSend } = renderPanel()
    type('oi ')
    act(() => box().blur())
    commentOn(firstP(container))
    expect(firstP(container).classList.contains('qc-pending')).toBe(true)
    act(() => {
      box().querySelector('img.inline-att-quote')!.remove() // o que o Backspace/Delete faz com o <img>
      box().dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(tokens()).toEqual([])
    expect(firstP(container).classList.contains('qc-pending')).toBe(false)
    send()
    expect(onSend).toHaveBeenCalledWith('oi ', [], [], [])
  })

  it('só o trecho, sem texto digitado, também envia', () => {
    const { container, onSend } = renderPanel()
    commentOn(answer(container, 'a1').querySelector('.md li')!)
    send()
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0]).toBe('> [trecho 1] · mensagem a1\n> item da lista\n\n[trecho 1]')
  })

  it('sem trecho e sem texto, nada sai (como antes)', () => {
    const { onSend } = renderPanel()
    send()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('o mesmo bloco duas vezes não duplica o trecho e avisa por toast', () => {
    const { container } = renderPanel()
    commentOn(firstP(container))
    commentOn(firstP(container))
    expect(tokens()).toHaveLength(1)
    expect(document.querySelector('.toast.aviso')?.textContent).toContain('já está citado')
  })

  it('trecho longo (bloco de código) sai cortado com "…", mantendo o id', () => {
    const { container, onSend } = renderPanel()
    type('Esse trecho está certo? ')
    act(() => box().blur())
    commentOn(answer(container, 'a1').querySelector('.qc-pre')!)
    send()
    const text = onSend.mock.calls[0][0]
    expect(text.startsWith('> [trecho 1] · mensagem a1\n> linha 0 do código\n> linha 1 do código')).toBe(true)
    const quoted = text
      .split('\n')
      .slice(1)
      .filter((l) => l.startsWith('>'))
      .map((l) => l.replace(/^> ?/, ''))
      .join('\n')
    expect(quoted.endsWith('…')).toBe(true)
    expect(quoted.length).toBeLessThanOrEqual(QUOTE_MAX_CHARS)
    expect(text).not.toContain('linha 79 do código')
    expect(text.endsWith('\n\nEsse trecho está certo? [trecho 1]')).toBe(true)
  })

  it('bloco com trecho no campo fica destacado; depois de enviado, o histórico (cabeçalho novo) marca como comentado', () => {
    const { container, onSend, rerender } = renderPanel()
    commentOn(firstP(container))
    expect(firstP(container).classList.contains('qc-pending')).toBe(true)
    send()
    expect(firstP(container).classList.contains('qc-pending')).toBe(false)
    rerender({ messages: [...MESSAGES, { kind: 'user', id: 'u2', text: onSend.mock.calls[0][0] }] })
    expect(firstP(container).classList.contains('qc-commented')).toBe(true)
  })

  it('convive com imagem no mesmo texto: {{midia:1}} para a imagem, [trecho 1] para o trecho', async () => {
    const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const png = new File([Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0))], 'tela.png', { type: 'image/png' })
    const { container, onSend } = renderPanel()
    type('veja  e ')
    caretAt(5)
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [png] } })
    await screen.findByAltText('Imagem anexada: tela.png')
    act(() => box().blur())
    commentOn(firstP(container))
    send()
    const [text, images] = onSend.mock.calls[0]
    expect(text).toBe(`${P1}\n\nveja {{midia:1}} e [trecho 1]`)
    expect(images.map((i) => i.label)).toEqual(['midia:1 = tela.png'])
  })

  it('o trecho vai para o rascunho da conversa ao trocar, e volta com ela', () => {
    const { container, onDraftChange, rerender } = renderPanel()
    type('sobre ')
    act(() => box().blur())
    commentOn(firstP(container))
    rerender({ convId: 'c2' })
    expect(tokens()).toEqual([])
    const saved = onDraftChange.mock.calls.filter((c) => c[0] === 'c1').at(-1)!
    expect(saved[1]).toBe('sobre {{midia:1}}')
    expect(saved[2]).toEqual([{ kind: 'quote', messageId: 'a1', text: 'Primeiro parágrafo.' }])
    rerender({ convId: 'c1', draft: saved[1], draftMedia: saved[2] })
    expect(tokens()).toEqual(['Trecho citado 1: Primeiro parágrafo.'])
    expect(firstP(container).classList.contains('qc-pending')).toBe(true)
  })

  it('o botão de revisão (/code-review) não leva o trecho; ele continua no campo', () => {
    const { container, onSend } = renderPanel()
    commentOn(firstP(container))
    fireEvent.click(screen.getByTitle(/Revisar código/))
    expect(onSend).toHaveBeenCalledWith('/code-review', [], [], [])
    expect(tokens()).toHaveLength(1)
  })

  it('o botão "Comentar" não rouba o foco do campo no mousedown (é isso que mantém o cursor)', () => {
    const { container } = renderPanel()
    const btn = within(firstP(container)).getByRole('button', { name: BTN })
    expect(fireEvent.mouseDown(btn)).toBe(false) // preventDefault
  })

  it('a mensagem do usuário não tem "Comentar"', () => {
    const { container } = renderPanel()
    expect(within(container.querySelector('.msg.user') as HTMLElement).queryByRole('button', { name: BTN })).toBeNull()
  })
})

describe('ChatPanel — o mesmo "Comentar" no chat do planejamento (ManagerChatFloat)', () => {
  const CARDS: PlanningCardDto[] = [{ id: 'login', tipo: 'requisito', titulo: 'Login com SSO', links: [], rev: 1, corpo: '' }]
  const inFloat = (p: ReactNode): ReactNode => (
    <div className="pl-main">
      <ManagerChatFloat cards={CARDS}>{p}</ManagerChatFloat>
    </div>
  )

  it('maximizado: dois trechos intercalados com o texto numa mensagem só', () => {
    const { container, onSend } = renderPanel({}, inFloat)
    expect(container.querySelector('.pl-chat-float .chat-panel')).toBeTruthy()
    type('a ')
    act(() => box().blur())
    commentOn(firstP(container))
    type(`a ${TOKEN} b `)
    act(() => box().blur())
    commentOn(otherP(container))
    send()
    expect(onSend.mock.calls[0][0]).toBe(
      `${P1}\n\n> [trecho 2] · mensagem a2\n> Outra resposta, de outra mensagem.\n\na [trecho 1] b [trecho 2]`
    )
  })

  it('minimizado (compacto): o botão continua nos blocos e o fluxo é o mesmo', () => {
    const { container, onSend } = renderPanel({}, inFloat)
    fireEvent.click(screen.getByRole('button', { name: 'Minimizar o chat do Agent Manager' }))
    expect(container.querySelector('.pl-chat-float.minimized')).toBeTruthy()
    commentOn(firstP(container))
    send()
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0]).toBe(`${P1}\n\n[trecho 1]`)
  })

  it('com [[Nome]] de card no bloco, o trecho citado é o texto visível (o nome do card)', () => {
    const messages: UIMessage[] = [
      { kind: 'assistant-text', id: 'a3', text: 'Depende de [[Login com SSO]].', final: true, answer: true }
    ]
    const { container, onSend } = renderPanel({ messages }, inFloat)
    const p = container.querySelector('.msg.assistant .md > p')!
    expect(p.querySelector('.pl-card-ref')).toBeTruthy()
    commentOn(p)
    send()
    expect(onSend.mock.calls[0][0]).toBe('> [trecho 1] · mensagem a3\n> Depende de Login com SSO.\n\n[trecho 1]')
  })
})
