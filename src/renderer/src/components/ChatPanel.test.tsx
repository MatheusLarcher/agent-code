import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRef, type ComponentProps, type ReactNode } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { ChatPanel } from './ChatPanel'
import { ChatDisplayContext } from './chatDisplay'
import { ManagerChatFloat } from '../planning/ManagerChatFloat'
import { UiProvider } from '../ui/UiProvider'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

// jsdom não implementa scrollIntoView — o MessageList chama isso ao montar.
Element.prototype.scrollIntoView = vi.fn()

function renderPanel(
  overrides: Partial<ComponentProps<typeof ChatPanel>> = {},
  wrap: (panel: ReactNode) => ReactNode = (panel) => panel
) {
  return render(
    <UiProvider>
      {wrap(
        <ChatPanel
          messages={[]}
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
          models={[
            { id: 'claude-opus-5-5', label: 'Opus 5.5' },
            { id: 'claude-sonnet-5', label: 'Sonnet 5' }
          ]}
          model="claude-opus-5-5"
          runningModel="claude-opus-5-5"
          modelLocked={false}
          onModelChange={() => {}}
          onModelLockedClick={() => {}}
          effortLevels={[
            { value: 'low', label: 'Baixo' },
            { value: 'high', label: 'Alto' }
          ]}
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
      )}
    </UiProvider>
  )
}

const consumo = (c: HTMLElement) => ({
  header: c.querySelector('.chat-header .token-meter'),
  last: c.querySelector('.last-usage-float'),
  windows: screen.queryByText('Controle do Windows ativo')
})

describe('ChatPanel — modo compacto (ChatDisplayContext)', () => {
  const withMessages = {
    messages: [{ kind: 'user' as const, id: 'u1', text: 'Oi' }],
    windowsControlEnabled: true,
    tokens: { context: 1200, output: 300, cost: 0.12, lastOutput: 40, lastCost: 0.01 }
  }

  it('sem o contexto (chat normal), mostra o consumo, a "Última resposta" e o aviso do Windows', () => {
    const { container } = renderPanel(withMessages)
    const seen = consumo(container)
    expect(seen.header).toBeTruthy()
    expect(seen.last).toBeTruthy()
    expect(seen.windows).toBeTruthy()
    expect(screen.getByText('↑ 300 saída')).toBeTruthy()
  })

  it('compacto: sem consumo nem aviso do Windows — a conversa e o composer ficam', () => {
    const { container } = renderPanel(withMessages, (panel) => (
      <ChatDisplayContext.Provider value={{ compact: true }}>{panel}</ChatDisplayContext.Provider>
    ))
    const seen = consumo(container)
    expect(container.querySelector('.chat-header')).toBeNull()
    expect(seen.header).toBeNull()
    expect(seen.last).toBeNull()
    expect(seen.windows).toBeNull()
    expect(screen.queryByText(/saída/)).toBeNull()
    expect(screen.getByText('Oi')).toBeTruthy()
    expect(screen.getByPlaceholderText(/Mensagem para o Claude/i)).toBeTruthy()
  })

  it('contexto explícito com compact: false é o chat normal', () => {
    const { container } = renderPanel(withMessages, (panel) => (
      <ChatDisplayContext.Provider value={{ compact: false }}>{panel}</ChatDisplayContext.Provider>
    ))
    expect(classesOf(container.querySelector('.chat-panel'))).toEqual([
      'chat-header',
      'windows-control-banner',
      'message-list-wrap',
      'last-usage-float',
      'composer-bar',
      'composer'
    ])
  })

  it('no painel flutuante do planejamento: consumo só maximizado, e o aviso do Windows nunca', () => {
    const { container } = renderPanel(withMessages, (panel) => <ManagerChatFloat>{panel}</ManagerChatFloat>)
    expect(consumo(container).header).toBeTruthy()
    expect(consumo(container).last).toBeTruthy()
    expect(consumo(container).windows).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Minimizar o chat do Agent Manager' }))
    expect(Object.values(consumo(container)).some(Boolean)).toBe(false)
    expect(screen.getByText('Oi')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Maximizar o chat do Agent Manager' }))
    expect(consumo(container).header).toBeTruthy()
    expect(consumo(container).windows).toBeNull()
  })
})

describe('ChatPanel — hideSessionToggles (conversa de planejamento)', () => {
  it('sem a prop (conversa normal), modelo, esforço, Econômico e Loop continuam na barra', () => {
    const { container } = renderPanel()
    expect(container.querySelector('select.model-select')).toBeTruthy()
    expect(container.querySelector('.effort-picker')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Econômico/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Loop/ })).toBeTruthy()
  })

  it('com a prop, somem Econômico e Loop — modelo e esforço ficam para trocar o do Agent Manager', () => {
    const onModelChange = vi.fn()
    const { container } = renderPanel({ hideSessionToggles: true, onModelChange })
    expect(screen.queryByRole('button', { name: /Econômico/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Loop/ })).toBeNull()
    expect(container.querySelector('.effort-picker')).toBeTruthy()
    const select = container.querySelector('select.model-select') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'claude-sonnet-5' } })
    expect(onModelChange).toHaveBeenCalledWith('claude-sonnet-5')
    expect(screen.getByPlaceholderText(/Mensagem para o Claude/i)).toBeTruthy()
  })
})

const classesOf = (el: Element | null | undefined): string[] =>
  [...(el?.children ?? [])].map((c) => c.getAttribute('class') ?? c.tagName.toLowerCase())

describe('ChatPanel — coluna estreita sem mexer no chat em largura normal', () => {
  // A coluna estreita se resolve só em CSS (container query): a estrutura que o
  // chat normal renderiza tem de continuar exatamente a mesma.
  it('mantém a ordem e as classes do painel e da linha do composer', () => {
    const { container } = renderPanel({ messages: [{ kind: 'user', id: 'u1', text: 'Oi' }] })
    expect(classesOf(container.querySelector('.chat-panel'))).toEqual([
      'chat-header',
      'message-list-wrap',
      'last-usage-float',
      'composer-bar',
      'composer'
    ])
    expect(classesOf(container.querySelector('.composer-row'))).toEqual([
      'ref-wrap',
      'ref-btn',
      'mic-wrap',
      'composer-input-wrap',
      'ref-btn',
      'btn send'
    ])
    expect(classesOf(container.querySelector('.last-usage-float'))).toEqual([
      'last-usage-title',
      'tok in',
      'tok out',
      'tok cost'
    ])
  })

  it('o CSS só reorganiza o composer e o rodapé dentro do container "chat" abaixo de 560px', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
    expect(css).toMatch(/\.chat-panel \{[^}]*container: chat \/ inline-size;/)
    const start = css.indexOf('@container chat (width < 560px) {')
    expect(start).toBeGreaterThan(-1)
    // O bloco fecha na primeira chave sem recuo (as regras de dentro são recuadas).
    const narrow = css.slice(start, css.indexOf('\n}', start))
    expect(narrow).toMatch(/\.composer-row > \.composer-input-wrap \{ order: -1; flex: 1 0 100%; \}/)
    expect(narrow).toMatch(/\.composer-row \{ flex-wrap: wrap;/)
    expect(narrow).toMatch(/\.last-usage-float \{[^}]*flex-wrap: nowrap;/)
    // Fora do bloco estreito ninguém quebra a linha do composer nem reordena a caixa.
    const outside = css.slice(0, start) + css.slice(start + narrow.length)
    expect(outside).not.toMatch(/\.composer-row[^{]*\{[^}]*flex-wrap: wrap/)
    expect(outside).not.toMatch(/\.composer-input-wrap[^{]*\{[^}]*order:/)
  })
})
