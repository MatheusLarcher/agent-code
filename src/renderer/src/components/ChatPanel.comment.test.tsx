import { createRef, type ComponentProps, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { PlanningCardDto } from '@shared/ipc'
import type { UIMessage } from '../types'
import { UiProvider } from '../ui/UiProvider'
import { ManagerChatFloat } from '../planning/ManagerChatFloat'
import { ChatPanel } from './ChatPanel'
import { QUOTE_MAX_CHARS, buildQuotedMessage } from './quoteComment/quoteFormat'
import type { SendFn } from './quoteComment/useQuoteComments'

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
  const composerRef = createRef<HTMLElement | null>()
  const all = { onSend, composerRef, ...overrides }
  const view = render(<UiProvider>{wrap(panel(all))}</UiProvider>)
  const rerender = (next: Partial<PanelProps>): void => view.rerender(<UiProvider>{wrap(panel({ ...all, ...next }))}</UiProvider>)
  return { ...view, onSend, composerRef, rerender }
}

const box = (): HTMLTextAreaElement => screen.getByPlaceholderText(/Mensagem para o Claude/) as HTMLTextAreaElement
const answer = (c: HTMLElement, id: string): HTMLElement =>
  [...c.querySelectorAll<HTMLElement>('.msg.assistant')].find((m) => m.textContent?.includes(id === 'a1' ? 'Primeiro' : 'Outra'))!
const commentOn = (block: Element): void => {
  fireEvent.click(within(block as HTMLElement).getByRole('button', { name: BTN }))
}
const chipRow = (c: HTMLElement): HTMLElement | null => c.querySelector('.composer .qc-chips')
const chipTexts = (c: HTMLElement): string[] => [...c.querySelectorAll('.composer .qc-chip-text')].map((e) => e.textContent ?? '')
const send = (text = ''): void => {
  if (text) fireEvent.change(box(), { target: { value: text } })
  fireEvent.keyDown(box(), { key: 'Enter' })
}

/** O fluxo inteiro num ChatPanel já montado (vale dentro e fora do planejamento). */
function commentFlow(c: HTMLElement, onSend: ReturnType<typeof vi.fn<SendFn>>): void {
  commentOn(answer(c, 'a1').querySelector('.md > p')!)
  commentOn(answer(c, 'a2').querySelector('.md > p')!)
  expect(chipTexts(c)).toEqual(['Primeiro parágrafo.', 'Outra resposta, de outra mensagem.'])
  send('Concordo com os dois.')
  expect(onSend).toHaveBeenCalledTimes(1)
  expect(onSend.mock.calls[0][0]).toBe(
    [
      '> ↳ trecho da mensagem a1',
      '> Primeiro parágrafo.',
      '',
      '> ↳ trecho da mensagem a2',
      '> Outra resposta, de outra mensagem.',
      '',
      'Concordo com os dois.'
    ].join('\n')
  )
  expect(chipRow(c)).toBeNull()
}

describe('ChatPanel — "Comentar" um trecho da resposta (chat principal)', () => {
  it('o clique cria o chip "↳ trecho" no campo de mensagem e leva o foco para lá; o × remove', () => {
    const { container, composerRef } = renderPanel()
    expect(chipRow(container)).toBeNull()
    commentOn(answer(container, 'a1').querySelector('.md > p')!)
    const row = chipRow(container)!
    expect(row.closest('.composer')).toBeTruthy()
    expect(chipTexts(container)).toEqual(['Primeiro parágrafo.'])
    expect(row.textContent).toContain('↳')
    expect(document.activeElement).toBe(composerRef.current)
    fireEvent.click(within(row).getByRole('button', { name: /Remover o trecho citado/ }))
    expect(chipRow(container)).toBeNull()
  })

  it('dois chips + texto saem numa mensagem só, com os trechos literais, os ids e o comentário no fim; os chips somem', () => {
    const { container, onSend } = renderPanel()
    commentFlow(container, onSend)
    // Enviados, os chips somem e o destaque de pendente sai junto (o de comentado
    // depende do histórico, que vem do App — ver o teste do destaque abaixo).
    expect(container.querySelector('.qc-pending')).toBeNull()
  })

  it('só chips, sem texto, também envia', () => {
    const { container, onSend } = renderPanel()
    commentOn(answer(container, 'a1').querySelector('.md li')!)
    send()
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0]).toBe('> ↳ trecho da mensagem a1\n> item da lista')
    expect(chipRow(container)).toBeNull()
  })

  it('sem chip e sem texto, nada sai (como antes)', () => {
    const { onSend } = renderPanel()
    send()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('trecho longo (bloco de código) sai cortado com "…", mantendo o id', () => {
    const { container, onSend } = renderPanel()
    commentOn(answer(container, 'a1').querySelector('.qc-pre')!)
    send('Esse trecho está certo?')
    const text = onSend.mock.calls[0][0]
    expect(text.startsWith('> ↳ trecho da mensagem a1\n> linha 0 do código\n> linha 1 do código')).toBe(true)
    const quoted = text
      .split('\n')
      .slice(1)
      .filter((l) => l.startsWith('>'))
      .map((l) => l.replace(/^> ?/, ''))
      .join('\n')
    expect(quoted.endsWith('…')).toBe(true)
    expect(quoted.length).toBeLessThanOrEqual(QUOTE_MAX_CHARS)
    expect(text).not.toContain('linha 79 do código')
    expect(text.endsWith('\n\nEsse trecho está certo?')).toBe(true)
  })

  it('bloco com chip pendente fica destacado; depois de enviado, o histórico marca como comentado', () => {
    const { container, onSend, rerender } = renderPanel()
    const first = (): HTMLElement => answer(container, 'a1').querySelector('.md > p')!
    commentOn(first())
    expect(first().classList.contains('qc-pending')).toBe(true)
    send('ok')
    expect(first().classList.contains('qc-pending')).toBe(false)
    // O App põe a mensagem enviada no histórico: o bloco passa a "comentado".
    rerender({ messages: [...MESSAGES, { kind: 'user', id: 'u2', text: onSend.mock.calls[0][0] }] })
    expect(first().classList.contains('qc-commented')).toBe(true)
  })

  it('trocar de conversa zera os chips', () => {
    const { container, rerender } = renderPanel()
    commentOn(answer(container, 'a1').querySelector('.md > p')!)
    expect(chipTexts(container)).toHaveLength(1)
    rerender({ convId: 'c2' })
    expect(chipRow(container)).toBeNull()
    rerender({ convId: 'c1' })
    expect(chipRow(container)).toBeNull()
  })

  it('o botão de revisão (/code-review) não leva os trechos pendentes', () => {
    const { container, onSend } = renderPanel()
    commentOn(answer(container, 'a1').querySelector('.md > p')!)
    fireEvent.click(screen.getByTitle(/Revisar código/))
    expect(onSend).toHaveBeenCalledWith('/code-review', [], [], [])
    expect(chipTexts(container)).toEqual(['Primeiro parágrafo.'])
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

  it('maximizado: dois chips + texto numa mensagem só', () => {
    const { container, onSend } = renderPanel({}, inFloat)
    expect(container.querySelector('.pl-chat-float .chat-panel')).toBeTruthy()
    commentFlow(container, onSend)
  })

  it('minimizado (compacto): o botão continua nos blocos e o fluxo é o mesmo', () => {
    const { container, onSend } = renderPanel({}, inFloat)
    fireEvent.click(screen.getByRole('button', { name: 'Minimizar o chat do Agent Manager' }))
    expect(container.querySelector('.pl-chat-float.minimized')).toBeTruthy()
    commentOn(answer(container, 'a1').querySelector('.md > p')!)
    send()
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0]).toBe(buildQuotedMessage([{ messageId: 'a1', text: 'Primeiro parágrafo.' }], ''))
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
    expect(onSend.mock.calls[0][0]).toBe('> ↳ trecho da mensagem a3\n> Depende de Login com SSO.')
  })
})
