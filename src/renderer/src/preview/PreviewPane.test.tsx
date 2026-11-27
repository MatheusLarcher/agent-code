import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('./WebPreview', () => ({
  WebPreview: ({ src }: { src: string }) => <div data-testid="web">{src}</div>
}))
vi.mock('./FilePreview', () => ({
  FilePreview: ({ tab }: { tab: { target: string } }) => <div data-testid="file">{tab.target}</div>
}))

import { PreviewPane } from './PreviewPane'
import { PreviewProvider, usePreviewController } from './PreviewContext'

afterEach(cleanup)

function Shell({ children }: { children: ReactNode }): JSX.Element {
  const controller = usePreviewController({ onReveal: () => {}, onPick: () => {}, cwd: 'C:\\proj' })
  return <PreviewProvider controller={controller}>{children}</PreviewProvider>
}

const address = (): HTMLInputElement => screen.getByRole('textbox', { name: /Endereço/ }) as HTMLInputElement

function go(value: string): void {
  fireEvent.change(address(), { target: { value } })
  fireEvent.keyDown(address(), { key: 'Enter' })
}

describe('PreviewPane', () => {
  it('fora do provider mostra aviso em vez de quebrar', () => {
    render(<PreviewPane />)
    expect(screen.getByRole('alert').textContent).toContain('O Preview não está disponível nesta janela.')
  })

  it('sem nada aberto explica como começar', () => {
    render(<PreviewPane />, { wrapper: Shell })
    expect(screen.getByText('Nada aberto no Preview')).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('endereço que não é link nem arquivo mostra o erro', () => {
    render(<PreviewPane />, { wrapper: Shell })
    go('mailto:x@y.com')
    expect(screen.getByRole('alert').textContent).toContain('Endereço não reconhecido')
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('caminho de arquivo abre aba e vai para o leitor de arquivo', () => {
    render(<PreviewPane />, { wrapper: Shell })
    go('a.md')
    const tab = screen.getByRole('tab')
    expect(tab.getAttribute('aria-selected')).toBe('true')
    expect(tab.textContent).toContain('a.md')
    expect(screen.getByTestId('file').textContent).toBe('C:\\proj\\a.md')
  })

  it('link vai para o webview e o endereço novo troca o alvo da mesma aba', () => {
    render(<PreviewPane />, { wrapper: Shell })
    go('example.com')
    expect(screen.getByTestId('web').textContent).toBe('https://example.com')
    go('https://outro.com/x')
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.getByTestId('web').textContent).toBe('https://outro.com/x')
  })

  it('Selecionar fica disponível em qualquer aba aberta, inclusive de arquivo', () => {
    render(<PreviewPane />, { wrapper: Shell })
    const pick = (): HTMLButtonElement => screen.getByRole('button', { name: /Selecionar/ }) as HTMLButtonElement
    expect(pick().disabled).toBe(true)
    go('a.md')
    expect(pick().disabled).toBe(false)
    go('C:\\proj\\planilha.xlsx')
    expect(pick().disabled).toBe(false)
  })

  it('não tem camada própria de soltar arquivo (é o RightPaneDrop que cuida)', () => {
    const { container } = render(<PreviewPane />, { wrapper: Shell })
    const stage = container.querySelector('.pp-stage')!
    const ev = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], files: [] } })
    stage.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(container.querySelector('.pp-drop')).toBeNull()
  })

  it('fechar a única aba volta ao estado vazio', () => {
    render(<PreviewPane />, { wrapper: Shell })
    go('example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Fechar example.com' }))
    expect(screen.getByText('Nada aberto no Preview')).toBeTruthy()
  })
})
