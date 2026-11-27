import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { PreviewProvider, usePreviewController, usePreviewState } from './PreviewContext'
import { RightPaneDrop, announceFileDrag } from './RightPaneDrop'

type FakeFile = { name: string; path?: string; bad?: boolean }

const onReveal = vi.fn()

function Shell({ children }: { children: ReactNode }): JSX.Element {
  const controller = usePreviewController({ onReveal, onPick: () => {}, cwd: 'C:\\proj' })
  return <PreviewProvider controller={controller}>{children}</PreviewProvider>
}

/** Mostra as abas do Preview para o teste conferir o que abriu. */
function Tabs(): JSX.Element {
  const st = usePreviewState()
  return <ul data-testid="tabs">{st?.tabs.map((t) => <li key={t.id}>{t.target}</li>)}</ul>
}

function renderPane(): { pane: HTMLElement; inner: HTMLElement } {
  render(
    <Shell>
      <RightPaneDrop className="right-pane" style={{ flex: '0 0 300px' }}>
        <div data-testid="inner">Quadro</div>
        <Tabs />
      </RightPaneDrop>
    </Shell>
  )
  const inner = screen.getByTestId('inner')
  return { pane: inner.parentElement as HTMLElement, inner }
}

const files = (list: FakeFile[]) => ({ dataTransfer: { types: ['Files'], files: list, dropEffect: 'none' } })
const tabs = (): string[] => Array.from(screen.getByTestId('tabs').children).map((li) => li.textContent ?? '')
const layer = (): HTMLElement | null => screen.queryByTestId('rp-drop')

beforeEach(() => {
  onReveal.mockReset()
  ;(window as unknown as { api: unknown }).api = {
    getPathForFile: (f: FakeFile) => {
      if (f.bad) throw new Error('sem caminho')
      return f.path ?? ''
    }
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

describe('RightPaneDrop', () => {
  it('mantém o painel como .right-pane, com os filhos diretos', () => {
    const { pane } = renderPane()
    expect(pane.classList.contains('right-pane')).toBe(true)
    expect(pane.style.flex).toBe('0 0 300px')
    expect(layer()).toBeNull()
  })

  it('arquivo entrando mostra a camada; sair de vez (contador zera) esconde', () => {
    const { pane, inner } = renderPane()
    expect(fireEvent.dragEnter(pane, files([]))).toBe(false) // preventDefault
    expect(layer()?.textContent).toContain('Solte para abrir no Preview')
    // Cruzar um filho: entra no filho antes de sair do pai, a camada fica.
    fireEvent.dragEnter(inner, files([]))
    fireEvent.dragLeave(pane, files([]))
    expect(layer()).not.toBeNull()
    expect(fireEvent.dragOver(inner, files([]))).toBe(false)
    fireEvent.dragLeave(inner, files([]))
    expect(layer()).toBeNull()
  })

  it('soltar abre cada arquivo numa aba do Preview e traz o Preview para a frente', () => {
    const { pane } = renderPane()
    fireEvent.dragEnter(pane, files([]))
    const dropped = fireEvent.drop(
      pane,
      files([
        { name: 'a.md', path: 'C:\\proj\\a.md' },
        { name: 'x', bad: true },
        { name: 'sem-caminho' },
        { name: 'b.xlsx', path: 'D:\\dados\\b.xlsx' }
      ])
    )
    expect(dropped).toBe(false)
    expect(layer()).toBeNull()
    expect(tabs()).toEqual(['C:\\proj\\a.md', 'D:\\dados\\b.xlsx'])
    expect(onReveal).toHaveBeenCalled()
  })

  it('arraste sem arquivo (cartão do Quadro) passa direto: sem camada e sem barrar o padrão', () => {
    const { pane } = renderPane()
    const card = { dataTransfer: { types: ['application/x-board-card', 'text/plain'], files: [] } }
    expect(fireEvent.dragEnter(pane, card)).toBe(true)
    expect(fireEvent.dragOver(pane, card)).toBe(true)
    expect(layer()).toBeNull()
    expect(fireEvent.drop(pane, card)).toBe(true)
    expect(tabs()).toEqual([])
    expect(onReveal).not.toHaveBeenCalled()
  })

  it('aviso do webview (announceFileDrag) mostra a camada, que some sozinha se o arraste parar', () => {
    vi.useFakeTimers()
    renderPane()
    act(() => announceFileDrag())
    expect(layer()).not.toBeNull()
    // Avisos seguidos mantêm a camada.
    act(() => vi.advanceTimersByTime(1000))
    act(() => announceFileDrag())
    act(() => vi.advanceTimersByTime(1000))
    expect(layer()).not.toBeNull()
    act(() => vi.advanceTimersByTime(300))
    expect(layer()).toBeNull()
  })

  it('soltar em outro lugar da janela ou cancelar o arraste esconde a camada', () => {
    const { pane } = renderPane()
    fireEvent.dragEnter(pane, files([]))
    act(() => {
      window.dispatchEvent(new Event('drop'))
    })
    expect(layer()).toBeNull()
    act(() => announceFileDrag())
    expect(layer()).not.toBeNull()
    act(() => {
      window.dispatchEvent(new Event('dragend'))
    })
    expect(layer()).toBeNull()
  })

  it('sem Preview (fora do provider) é só o painel', () => {
    render(
      <RightPaneDrop className="right-pane">
        <div data-testid="inner">x</div>
      </RightPaneDrop>
    )
    const pane = screen.getByTestId('inner').parentElement as HTMLElement
    expect(pane.className).toBe('right-pane')
    expect(fireEvent.dragEnter(pane, files([]))).toBe(true)
    act(() => announceFileDrag())
    expect(layer()).toBeNull()
  })
})
