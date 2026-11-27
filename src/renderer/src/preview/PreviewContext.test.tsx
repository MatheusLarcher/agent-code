import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { InspectorPick } from '@shared/preview'
import { usePreview, usePreviewController, usePreviewState } from './PreviewContext'

afterEach(cleanup)

function setup(cwd = 'C:\\proj') {
  const onReveal = vi.fn()
  const onPick = vi.fn()
  const hook = renderHook(() => usePreviewController({ onReveal, onPick, cwd }))
  return { ...hook, onReveal, onPick }
}

describe('usePreviewController', () => {
  it('abre uma aba, traz o Preview para a frente e reaproveita a mesma aba', () => {
    const { result, onReveal } = setup()
    let ok = false
    act(() => {
      ok = result.current.open.openInPreview('https://example.com/')
    })
    expect(ok).toBe(true)
    expect(result.current.state.tabs).toHaveLength(1)
    expect(result.current.state.activeId).toBe(result.current.state.tabs[0].id)
    expect(onReveal).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.open.openInPreview('C:\\proj\\a.md')
      result.current.open.openInPreview('https://example.com')
    })
    expect(result.current.state.tabs).toHaveLength(2)
    expect(result.current.state.activeId).toBe(result.current.state.tabs[0].id)
  })

  it('reveal:false abre sem mudar o painel; nome relativo usa a pasta do projeto', () => {
    const { result, onReveal } = setup()
    act(() => {
      result.current.open.openInPreview('a.md', { reveal: false })
    })
    expect(onReveal).not.toHaveBeenCalled()
    expect(result.current.state.tabs[0]).toMatchObject({ target: 'C:\\proj\\a.md', kind: 'markdown', title: 'a.md' })
  })

  it('alvo não reconhecido devolve false e não abre nada', () => {
    const { result, onReveal } = setup()
    let ok = true
    act(() => {
      ok = result.current.open.openInPreview('mailto:x@y.com')
    })
    expect(ok).toBe(false)
    expect(result.current.state.tabs).toHaveLength(0)
    expect(onReveal).not.toHaveBeenCalled()
  })

  it('fechar a aba ativa ativa a anterior; fechar a última deixa sem aba', () => {
    const { result } = setup()
    act(() => {
      result.current.open.openInPreview('https://a.com')
      result.current.open.openInPreview('https://b.com')
      result.current.open.openInPreview('https://c.com')
    })
    const [a, b, c] = result.current.state.tabs
    act(() => result.current.state.selectTab(b.id))
    act(() => result.current.state.closeTab(b.id))
    expect(result.current.state.tabs.map((t) => t.id)).toEqual([a.id, c.id])
    expect(result.current.state.activeId).toBe(a.id)
    act(() => result.current.state.closeTab(a.id))
    expect(result.current.state.activeId).toBe(c.id)
    act(() => result.current.state.closeTab(c.id))
    expect(result.current.state.activeId).toBeNull()
  })

  it('navegar troca alvo, tipo e título; título vazio é ignorado', () => {
    const { result } = setup()
    act(() => {
      result.current.open.openInPreview('https://a.com')
    })
    const id = result.current.state.tabs[0].id
    act(() => result.current.state.navigateTab(id, 'C:\\x\\b.json'))
    expect(result.current.state.tabs[0]).toMatchObject({ id, target: 'C:\\x\\b.json', kind: 'json', title: 'b.json' })
    act(() => result.current.state.setTitle(id, '   '))
    expect(result.current.state.tabs[0].title).toBe('b.json')
    act(() => result.current.state.setTitle(id, ' Página '))
    expect(result.current.state.tabs[0].title).toBe('Página')
  })

  it('o elemento apontado vira chip com o nome da aba', () => {
    const { result, onPick } = setup()
    act(() => {
      result.current.open.openInPreview('https://example.com')
    })
    const tab = result.current.state.tabs[0]
    const p: InspectorPick = { tagName: 'h1', selector: 'h1', id: '', classes: '', text: 'Oi', html: '<h1>Oi</h1>', url: 'https://example.com', index: 1 }
    act(() => result.current.state.pick(tab, p))
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ selector: 'h1', tabId: tab.id, tabName: 'Preview · example.com' }))
  })

  it('openInPreview não muda de identidade entre renders', () => {
    const { result } = setup()
    const first = result.current.open
    act(() => {
      result.current.open.openInPreview('https://a.com')
    })
    expect(result.current.open).toBe(first)
  })
})

describe('sem provider', () => {
  it('usePreview e usePreviewState devolvem null', () => {
    expect(renderHook(() => usePreview()).result.current).toBeNull()
    expect(renderHook(() => usePreviewState()).result.current).toBeNull()
  })
})
