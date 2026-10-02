import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatFloat, type ChatFloatCollapseScope, type ChatFloatPersist } from './ChatFloat'

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  }
})
afterEach(cleanup)

/** A janela do app: barra de cima com as abas, barra lateral e a área que hospeda o chat. */
function renderApp(scope?: ChatFloatCollapseScope) {
  const save = vi.fn()
  const persist: ChatFloatPersist = { load: () => false, save }
  render(
    <div>
      <header>
        <div className="main-tabs" role="tablist">
          <button type="button" role="tab">
            Escritório
          </button>
        </div>
        <button type="button">configurações</button>
      </header>
      <nav>
        <button type="button">outra conversa</button>
      </nav>
      <main>
        <div data-testid="palco">palco</div>
        <ChatFloat name="Teste" persist={persist} collapseScope={scope}>
          <textarea aria-label="mensagem" />
        </ChatFloat>
      </main>
    </div>
  )
  const panel = (): HTMLElement => screen.getByRole('region', { name: 'Teste' })
  return { save, minimized: (): boolean => panel().classList.contains('minimized') }
}

describe('ChatFloat — o que conta como "clicar fora"', () => {
  it("'document' (Planejamento, o padrão): qualquer lugar fora minimiza e grava — menos as abas da área principal", () => {
    const chat = renderApp()
    fireEvent.pointerDown(screen.getByRole('tab', { name: 'Escritório' }))
    expect(chat.minimized()).toBe(false)
    expect(chat.save).not.toHaveBeenCalled()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'outra conversa' }))
    expect(chat.minimized()).toBe(true)
    expect(chat.save).toHaveBeenCalledWith(true)
  })

  it("'area' (Escritório): só a área que hospeda o painel; barra lateral, barra de cima e abas não mexem no chat", () => {
    const chat = renderApp('area')
    const box = screen.getByLabelText('mensagem') as HTMLTextAreaElement
    box.focus()
    for (const name of ['outra conversa', 'configurações']) {
      fireEvent.pointerDown(screen.getByRole('button', { name }))
      expect(chat.minimized()).toBe(false)
    }
    fireEvent.pointerDown(screen.getByRole('tab', { name: 'Escritório' }))
    expect(chat.minimized()).toBe(false)
    expect(chat.save).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(box)
    // O palco (irmão do painel, na mesma área) continua minimizando e tirando o foco.
    fireEvent.pointerDown(screen.getByTestId('palco'))
    expect(chat.minimized()).toBe(true)
    expect(chat.save).toHaveBeenCalledWith(true)
    expect(document.activeElement).not.toBe(box)
  })
})
