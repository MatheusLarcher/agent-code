import { createRef, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../components/ChatPanel'
import { ChatDisplayContext } from '../components/chatDisplay'
import { Sidebar } from '../components/Sidebar'
import { UiProvider } from '../ui/UiProvider'
import type { Conversation } from '../types'

/**
 * A Central fora do painel dela: o "← Central" no topo da conversa aberta por
 * ela (ChatPanel, também no modo compacto) e, na barra lateral, as bolinhas dos
 * destinos trabalhando (item da Central e a linha da conversa, na cor dela).
 */

afterEach(cleanup)
Element.prototype.scrollIntoView = vi.fn()

function chat(overrides: Partial<ComponentProps<typeof ChatPanel>> = {}, compact = false) {
  const props: ComponentProps<typeof ChatPanel> = {
    messages: [],
    hasActive: true,
    busy: false,
    windowsControlEnabled: false,
    onDisableWindowsControl: () => {},
    tokens: { context: 0, output: 0, cost: 0 },
    chips: [],
    onChipsConsumed: () => {},
    onSend: () => {},
    onInterrupt: () => {},
    onRetry: () => {},
    composerRef: createRef(),
    projects: [],
    projectRoot: null,
    convId: 'c1',
    draft: '',
    onDraftChange: () => {},
    projectMissing: false,
    projectMissingMsg: '',
    queued: [],
    onDeleteQueued: () => {},
    onRetryRecovery: () => {},
    onCancelRecovery: () => {},
    runningSince: null,
    lastDurationMs: null,
    tts: { speakingId: null, onToggleSpeak: () => {} },
    models: [{ id: 'm', label: 'M' }],
    model: 'm',
    runningModel: 'm',
    modelLocked: false,
    onModelChange: () => {},
    onModelLockedClick: () => {},
    effortLevels: [],
    effort: 'high',
    effortLocked: false,
    onEffortChange: () => {},
    economyMode: false,
    onEconomyModeChange: () => {},
    loopEnabled: false,
    loopLocked: false,
    onLoopEnabledChange: () => {},
    fastModeAvailable: false,
    fastMode: false,
    onFastModeChange: () => {},
    pendingQuestion: false,
    onReopenQuestion: () => {},
    ...overrides
  }
  return render(
    <UiProvider>
      <ChatDisplayContext.Provider value={{ compact }}>
        <ChatPanel {...props} />
      </ChatDisplayContext.Provider>
    </UiProvider>
  )
}

describe('ChatPanel — "← Central"', () => {
  it('aparece no topo com onBackToCentral e o clique volta', () => {
    const back = vi.fn()
    const { container } = chat({ onBackToCentral: back })
    const btn = screen.getByRole('button', { name: 'Voltar para a Central' })
    expect(btn.textContent).toBe('Central')
    expect(btn.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('.chat-header > .central-back')).toBe(btn)
    fireEvent.click(btn)
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('sem a prop, não aparece', () => {
    chat()
    expect(screen.queryByRole('button', { name: 'Voltar para a Central' })).toBeNull()
  })

  it('compacto (chat flutuante minimizado): continua no topo', () => {
    const { container } = chat({ onBackToCentral: () => {} }, true)
    expect(container.querySelector('.chat-header')).toBeNull()
    expect(container.querySelector('.central-back-strip > .central-back')).not.toBeNull()
  })
})

const conv = (id: string, title: string): Conversation => ({
  id,
  title,
  cwd: 'C:/proj/app',
  model: 'm',
  sdkSessionId: null,
  messages: [],
  tokens: { context: 0, output: 0, cost: 0 },
  createdAt: 1,
  updatedAt: 2
})

describe('Sidebar — cores da Central', () => {
  it('bolinha na cor do destino só nas linhas dos destinos trabalhando; pontos no item da Central', () => {
    const a = conv('a', 'Tela de login')
    const b = conv('b', 'Mapa do projeto')
    const { container } = render(
      <UiProvider>
        <Sidebar
          collapsed={false}
          onToggleCollapse={() => {}}
          projects={[{ path: a.cwd, name: 'app', conversations: [a, b] }]}
          recents={[]}
          activeId={null}
          busyIds={new Set(['a'])}
          onSelect={() => {}}
          onNewChat={() => {}}
          onNewProject={() => {}}
          onNewChatIn={() => {}}
          onRename={() => {}}
          onDelete={() => {}}
          onSelectResult={() => {}}
          central={{ active: false, onSelect: () => {}, dots: ['#7fb3d5', '#8fc89a'] }}
          centralColors={{ a: '#7fb3d5' }}
        />
      </UiProvider>
    )
    const dots = screen.getAllByTestId('conv-central-dot')
    expect(dots).toHaveLength(1)
    expect(dots[0].closest('.conv-row')?.textContent).toContain('Tela de login')
    expect((dots[0] as HTMLElement).style.background).toBe('rgb(127, 179, 213)')
    expect(container.querySelectorAll('.central-dots i')).toHaveLength(2)
  })
})
