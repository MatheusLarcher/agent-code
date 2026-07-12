import { createRef } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ChatPanel } from './ChatPanel'
import { UiProvider } from '../ui/UiProvider'

afterEach(cleanup)

// jsdom não implementa scrollIntoView — o MessageList chama isso ao montar.
Element.prototype.scrollIntoView = vi.fn()

function renderPanel(pendingQuestion: boolean, onReopenQuestion = vi.fn()): { onReopenQuestion: typeof onReopenQuestion } {
  render(
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
    />
    </UiProvider>
  )
  return { onReopenQuestion }
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
