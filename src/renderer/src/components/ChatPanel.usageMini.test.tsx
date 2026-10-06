/**
 * O chat flutuante do Escritório (OfficeChatFloat) e o ChatPanel dentro dele:
 * sem a faixa "Controle do Windows ativo" e sem o medidor de consumo do
 * cabeçalho — só a barrinha fatiada (UsageMiniBar), que mostra os detalhes ao
 * passar o mouse e abre o painel por agente ao clicar. O chat do Agent
 * Manager (a TV) e o ChatPanel comum ficam como eram.
 */
import { createRef, type ComponentProps, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ManagerChatFloat } from '../planning/ManagerChatFloat'
import { OfficeChatFloat } from '../office3d/OfficeChatFloat'
import { UiProvider } from '../ui/UiProvider'
import { ChatPanel } from './ChatPanel'

Element.prototype.scrollIntoView = vi.fn()

const HISTORY = {
  calls: [],
  totals: [{ convId: 'c1', day: '2026-10-05', model: 'claude-opus-5-5', subagentType: null, sumInput: 1_200, sumOutput: 300, sumCacheRead: 8_000, sumCacheWrite: 500, sumCost: null, callCount: 4 }]
}

beforeEach(() => {
  localStorage.clear()
  ;(window as unknown as { api: unknown }).api = { getTokenUsageHistory: vi.fn(async () => HISTORY) }
})
afterEach(() => {
  cleanup()
  localStorage.clear()
  delete (window as unknown as { api?: unknown }).api
})

function panel(over: Partial<ComponentProps<typeof ChatPanel>> = {}): JSX.Element {
  return (
    <ChatPanel
      messages={[{ kind: 'user', id: 'u1', text: 'Oi' }]}
      hasActive
      busy={false}
      windowsControlEnabled
      onDisableWindowsControl={() => {}}
      tokens={{ context: 1200, output: 300, cost: 0.12, lastOutput: 40, lastCost: 0.01 }}
      chips={[]}
      onChipsConsumed={() => {}}
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
      tts={{ speakingId: null, onToggleSpeak: () => {} }}
      models={[{ id: 'claude-opus-5-5', label: 'Opus 5.5' }]}
      model="claude-opus-5-5"
      runningModel="claude-opus-5-5"
      modelLocked={false}
      onModelChange={() => {}}
      onModelLockedClick={() => {}}
      effortLevels={[{ value: 'high', label: 'Alto' }]}
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
      {...over}
    />
  )
}

const inUi = (node: ReactNode): JSX.Element => <UiProvider>{node}</UiProvider>
const office = (child: JSX.Element): JSX.Element =>
  inUi(
    <OfficeChatFloat conversation={{ id: 'c1', title: 'Loja', cwd: 'C:\\proj\\loja' }} onLocate={() => {}}>
      {child}
    </OfficeChatFloat>
  )

describe('chat flutuante do Escritório: a barrinha fatiada no lugar da faixa do Windows e do medidor', () => {
  it('maximizado: sem a faixa "Controle do Windows ativo" (mesmo com o controle ligado) e sem o medidor; a barrinha, a transparência, a conversa e o campo ficam', () => {
    const { container } = render(office(panel()))
    expect(screen.queryByText('Controle do Windows ativo')).toBeNull()
    expect(container.querySelector('.windows-control-banner')).toBeNull()
    expect(container.querySelector('.token-meter')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Detalhar consumo de tokens' })).toBeNull()
    expect(container.querySelector('.last-usage-float')).toBeNull()
    expect(container.querySelector('.chat-header [data-testid="usage-mini"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Transparência do chat' })).toBeTruthy()
    expect(screen.getByText('Oi')).toBeTruthy()
    expect(screen.getByPlaceholderText(/Mensagem para o Claude/i)).toBeTruthy()
  })

  it('o mouse na barrinha mostra o que é cada consumo, os números e o custo (com o histórico do banco)', async () => {
    const { container } = render(office(panel()))
    await waitFor(() => expect(container.querySelectorAll('.um-slice').length).toBe(4))
    fireEvent.mouseEnter(screen.getByTestId('usage-mini'))
    const tip = screen.getByRole('tooltip')
    expect(tip.textContent).toContain('Cache lido')
    expect(tip.textContent).toContain('8.000')
    expect(tip.textContent).toContain('4 chamadas')
    expect(tip.textContent).toContain('~US$ 0,12')
    expect(tip.textContent).toContain('1.200 / ')
  })

  it('o clique abre o painel por agente e subagente, com o custo no cabeçalho dele, e fecha no segundo clique', async () => {
    const { container } = render(office(panel()))
    const bar = screen.getByRole('button', { name: /^Consumo de tokens/ })
    expect(container.querySelector('.token-meter-panel')).toBeNull()
    fireEvent.click(bar)
    const open = container.querySelector('.token-meter-panel')!
    expect(open).toBeTruthy()
    expect(await screen.findByText('Consumo de tokens')).toBeTruthy()
    expect(open.querySelector('.token-usage-header')?.textContent).toContain('~US$ 0,12')
    expect(bar.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(bar)
    expect(container.querySelector('.token-meter-panel')).toBeNull()
  })

  it('minimizado, o chat é compacto como sempre: sem cabeçalho, sem barrinha', () => {
    const { container } = render(office(panel()))
    fireEvent.click(screen.getByRole('button', { name: 'Minimizar o chat do Escritório' }))
    expect(container.querySelector('.chat-header')).toBeNull()
    expect(screen.queryByTestId('usage-mini')).toBeNull()
    expect(screen.getByText('Oi')).toBeTruthy()
  })

  it('o chat da Central no mesmo painel não ganha faixa nem medidor (o painel dela não tem), e o ChatPanel comum e o do Agent Manager continuam como eram', () => {
    const view = render(inUi(<div className="chat-panel central-panel">Central</div>))
    expect(view.container.querySelector('.windows-control-banner, .token-meter, [data-testid="usage-mini"]')).toBeNull()
    cleanup()
    // Chat comum (sem o contexto do painel): o medidor de sempre e o aviso do Windows.
    const plain = render(inUi(panel()))
    expect(plain.container.querySelector('.token-meter')).toBeTruthy()
    expect(plain.container.querySelector('.windows-control-banner')).toBeTruthy()
    expect(plain.container.querySelector('[data-testid="usage-mini"]')).toBeNull()
    cleanup()
    // Agent Manager (a TV): o medidor, sem o aviso do Windows — como era.
    const manager = render(inUi(<ManagerChatFloat>{panel()}</ManagerChatFloat>))
    expect(manager.container.querySelector('.token-meter')).toBeTruthy()
    expect(manager.container.querySelector('.windows-control-banner')).toBeNull()
    expect(manager.container.querySelector('[data-testid="usage-mini"]')).toBeNull()
  })
})
