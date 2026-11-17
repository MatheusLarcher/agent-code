/**
 * No App inteiro: o painel da direita tem exatamente duas abas — Quadro (padrão)
 * e Scrum Master —, o trilho recolhido oferece as duas, a aba Scrum Master mostra
 * o Diário e abre a conversa do cartão, e a largura salva antes da troca de nome
 * (browserWidth) continua valendo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ScrumPanelSnapshot } from '@shared/scrumPanel'
import { App } from './App'
import { UiProvider } from './ui/UiProvider'
import { conv, installApi, KEY, toC1 } from './central/centralAppKit'
import { envio } from './office3d/scrum/scrumPanelFixtures'

configure({ asyncUtilTimeout: 10_000 })
window.HTMLElement.prototype.scrollIntoView = vi.fn()
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

vi.mock('./central/CentralPanel', async () => ({ CentralPanel: (await import('./central/centralAppKit')).MockCentralPanel }))

const SNAPSHOT: ScrumPanelSnapshot = {
  enabled: true,
  podeParar: true,
  logFile: 'C:\\u\\scrum-decisions.log',
  tiles: { acompanhados: 1, cobrancasHoje: 0, parados: 1 },
  contestados: 0,
  envios: [envio({ envioId: 'e2', convId: 'c2', conversationTitle: 'Outra conversa', projectCwd: '/proj', estado: 'parado', vezes: 3 })]
}

function boot(ui: Record<string, unknown>): { scrumPanel: ReturnType<typeof vi.fn> } {
  localStorage.clear()
  localStorage.setItem(KEY, JSON.stringify([conv('c1', 'Conversa', '/proj'), conv('c2', 'Outra conversa', '/proj')]))
  localStorage.setItem('agentcode.ui.v1', JSON.stringify({ collapsed: false, activeId: 'c1', ...ui }))
  const api = installApi(toC1) as unknown as Record<string, unknown>
  const scrumPanel = vi.fn(async () => ({ ok: true as const, snapshot: SNAPSHOT }))
  Object.assign(api, {
    scrumPanel,
    scrumHistory: vi.fn(async () => ({ ok: true as const, items: [], total: 0 })),
    scrumChatHistory: vi.fn(async () => ({ ok: true as const, messages: [], hasMore: false })),
    onScrumChanged: vi.fn(() => () => {})
  })
  render(
    <UiProvider>
      <App />
    </UiProvider>
  )
  return { scrumPanel }
}

const paneTabs = (): string[] => [...document.querySelectorAll('.pane-tabs [role="tab"]')].map((t) => t.textContent ?? '')

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('App — painel da direita: Quadro e Scrum Master', () => {
  it('duas abas, Quadro por padrão, na largura salva com o nome antigo; o Diário só é lido ao abrir a aba dele', async () => {
    const { scrumPanel } = boot({ browserMinimized: false, browserWidth: 512 })
    await waitFor(() => expect(paneTabs()).toEqual(['Quadro', 'Scrum Master']))
    expect(document.querySelector('.pane-tab.on')?.textContent).toBe('Quadro')
    expect((document.querySelector('.right-pane') as HTMLElement).style.flex).toBe('0 0 512px')
    expect(document.querySelector('.browser-panel')).toBeNull()
    expect(scrumPanel).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: /Scrum Master/ }))
    expect(await screen.findByRole('region', { name: 'Diário do Scrum Master' })).toBeTruthy()
    expect(scrumPanel).toHaveBeenCalledTimes(1)

    // O link do cartão abre a conversa dele no chat ao lado.
    fireEvent.click(await screen.findByRole('button', { name: 'Ver a conversa' }))
    await waitFor(() => expect(JSON.parse(localStorage.getItem('agentcode.ui.v1') ?? '{}')).toMatchObject({ activeId: 'c2', rightPaneWidth: 512 }))
  })

  it('painel recolhido: o trilho tem Quadro e Scrum Master, e cada um reabre na sua aba', async () => {
    boot({ browserMinimized: true })
    const rail = await waitFor(() => {
      const el = document.querySelector('.right-rail')
      expect(el).toBeTruthy()
      return el as HTMLElement
    })
    expect([...rail.querySelectorAll('.right-rail-btn')].map((b) => b.textContent)).toEqual(['Quadro', 'Scrum Master'])
    expect(screen.queryByRole('button', { name: /Navegador/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Scrum Master' }))
    expect(await screen.findByRole('region', { name: 'Diário do Scrum Master' })).toBeTruthy()
    expect(document.querySelector('.right-rail')).toBeNull()

    // O ✕ do Diário recolhe o painel de volta para o trilho.
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))
    await waitFor(() => expect(document.querySelector('.right-rail')).toBeTruthy())
  })
})
