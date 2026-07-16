import { createRef, type ComponentProps } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ChatPanel } from './ChatPanel'
import { UiProvider } from '../ui/UiProvider'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// jsdom não implementa scrollIntoView — o MessageList chama isso ao montar.
Element.prototype.scrollIntoView = vi.fn()

function renderPanel(
  pendingQuestion: boolean,
  onReopenQuestion = vi.fn(),
  overrides: Partial<ComponentProps<typeof ChatPanel>> = {}
) {
  const view = render(
    <UiProvider>
    <ChatPanel
      messages={[]}
      hasActive={true}
      busy={false}
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
      models={[]}
      model="claude-opus-4-8"
      modelLocked={false}
      onModelChange={() => {}}
      onModelLockedClick={() => {}}
      effortLevels={[]}
      effort="medium"
      effortLocked={false}
      onEffortChange={() => {}}
      economyMode={false}
      onEconomyModeChange={() => {}}
      pendingQuestion={pendingQuestion}
      onReopenQuestion={onReopenQuestion}
      {...overrides}
    />
    </UiProvider>
  )
  return { onReopenQuestion, ...view }
}

describe('ChatPanel — chip de pergunta pendente (entre o histórico e o composer)', () => {
  it('sem pergunta minimizada, o chip não aparece', () => {
    renderPanel(false)
    expect(screen.queryByText(/O agente fez uma pergunta/)).toBeNull()
  })

  it('com pergunta minimizada, o chip aparece evidenciado', () => {
    renderPanel(true)
    expect(screen.getByText(/O agente fez uma pergunta/)).toBeTruthy()
  })

  it('clicar no chip chama onReopenQuestion (reabre o modal)', () => {
    const { onReopenQuestion } = renderPanel(true)
    fireEvent.click(screen.getByText(/O agente fez uma pergunta/))
    expect(onReopenQuestion).toHaveBeenCalledTimes(1)
  })
})

describe('ChatPanel - identidade estavel dos filhos do feed', () => {
  it('nao colide keys quando o plano e mensagens com ids iguais coexistem', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    renderPanel(false, vi.fn(), {
      todoPlan: {
        active: true,
        items: [{ id: '1', content: 'Passo', activeForm: 'Fazendo o passo', status: 'in_progress' }]
      },
      messages: [
        { kind: 'user', id: 'shared', text: 'Pergunta' },
        { kind: 'assistant-text', id: 'shared', text: 'Resposta', final: true },
        { kind: 'thinking', id: 'shared', text: 'Pensando' },
        { kind: 'tool-use', id: 'shared', name: 'Read', input: {}, parentToolUseId: null },
        { kind: 'system', sessionId: 'shared', model: 'claude-opus-4-8', cwd: '/proj', tools: [] },
        { kind: 'error', id: 'shared', text: 'Falha' }
      ]
    })

    const duplicateKeyWarnings = consoleError.mock.calls.filter((args) =>
      args.some((arg) => typeof arg === 'string' && arg.includes('same key'))
    )
    expect(duplicateKeyWarnings).toEqual([])
    expect(document.querySelectorAll('.msg.user')).toHaveLength(1)
    expect(document.querySelectorAll('.msg.assistant')).toHaveLength(1)
    expect(document.querySelectorAll('.msg.thinking')).toHaveLength(1)
    expect(document.querySelectorAll('.tool-card')).toHaveLength(1)
    expect(document.querySelectorAll('.msg.system-note')).toHaveLength(1)
    expect(document.querySelectorAll('.msg.result-note.err')).toHaveLength(1)
  })
})
