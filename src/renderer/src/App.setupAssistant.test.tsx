/**
 * No App inteiro: uma tarefa de configuração ("Instalar para mim") abre um chat
 * de sandbox, mostra na bolha só o texto curto e manda o pedido completo ao agente.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, configure, render, screen, waitFor } from '@testing-library/react'
import { chromeExtensionSetupTask } from '@shared/setupTasks'
import { App } from './App'
import { UiProvider } from './ui/UiProvider'
import { conv, installApi, KEY, sends, toC1 } from './central/centralAppKit'
import { requestSetupTask } from './setup/setupAssistant'

configure({ asyncUtilTimeout: 10_000 })
window.HTMLElement.prototype.scrollIntoView = vi.fn()
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

vi.mock('./central/CentralPanel', async () => ({ CentralPanel: (await import('./central/centralAppKit')).MockCentralPanel }))

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('App — assistente de configuração', () => {
  it('abre um chat de sandbox e manda o pedido; a bolha mostra só o texto curto', async () => {
    localStorage.setItem(KEY, JSON.stringify([conv('c1', 'Conversa', '/proj')]))
    localStorage.setItem('agentcode.ui.v1', JSON.stringify({ collapsed: false, activeId: 'c1' }))
    const api = installApi(toC1)
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await screen.findByText('Conversa')
    const task = chromeExtensionSetupTask('C:\\dados\\chrome-extension')

    let accepted = false
    act(() => {
      accepted = requestSetupTask(task)
    })
    expect(accepted).toBe(true)

    await waitFor(() => expect(sends(api)).toHaveLength(1))
    const [convId, text] = sends(api)[0]
    expect(convId).not.toBe('c1')
    expect(text).toBe(task.prompt)
    expect(api.sandboxCreate).toHaveBeenCalledTimes(1)
    expect((await screen.findAllByText(task.display)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Carregar sem compactação/)).toBeNull()
  })
})
