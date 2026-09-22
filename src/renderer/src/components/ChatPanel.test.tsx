import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRef, type ComponentProps } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { ChatPanel } from './ChatPanel'
import { UiProvider } from '../ui/UiProvider'

afterEach(cleanup)

// jsdom não implementa scrollIntoView — o MessageList chama isso ao montar.
Element.prototype.scrollIntoView = vi.fn()

function renderPanel(overrides: Partial<ComponentProps<typeof ChatPanel>> = {}) {
  return render(
    <UiProvider>
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
    </UiProvider>
  )
}

describe('ChatPanel — hideModelControls (conversa de planejamento)', () => {
  it('sem a prop (conversa normal), modelo, esforço, Econômico e Loop continuam na barra', () => {
    const { container } = renderPanel()
    expect(container.querySelector('select.model-select')).toBeTruthy()
    expect(container.querySelector('.effort-picker')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Econômico/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Loop/ })).toBeTruthy()
  })

  it('com a prop, somem modelo, esforço, Econômico e Loop — o composer fica', () => {
    const { container } = renderPanel({ hideModelControls: true })
    expect(container.querySelector('select.model-select')).toBeNull()
    expect(container.querySelector('.effort-picker')).toBeNull()
    expect(screen.queryByRole('button', { name: /Econômico/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Loop/ })).toBeNull()
    expect(container.querySelector('.composer-bar')?.childElementCount).toBe(0)
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
