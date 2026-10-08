import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { claimTip, HoverTipLayer, SHOW_MS, tipTarget } from './HoverTip'

const over = (el: Element, pointerType = 'mouse'): void => {
  fireEvent.pointerOver(el, { pointerType, bubbles: true })
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('HoverTip', () => {
  it('o title vira data-tip (o nativo não aparece); sem texto visível, vai para o aria-label', () => {
    const b = document.createElement('button')
    b.title = 'Excluir cartão'
    expect(claimTip(b)).toBe('Excluir cartão')
    expect(b.hasAttribute('title')).toBe(false)
    expect(b.getAttribute('data-tip')).toBe('Excluir cartão')
    expect(b.getAttribute('aria-label')).toBe('Excluir cartão')
    const t = document.createElement('span')
    t.textContent = 'texto'
    t.title = 'dica'
    claimTip(t)
    expect(t.hasAttribute('aria-label')).toBe(false)
  })

  it('o mais próximo vence; data-no-tip desliga', () => {
    const { container } = render(
      <div title="fora">
        <span data-tip="dentro">
          <i>x</i>
        </span>
        <span data-no-tip>
          <b title="mudo">y</b>
        </span>
      </div>
    )
    expect(tipTarget(container.querySelector('i'))?.getAttribute('data-tip')).toBe('dentro')
    expect(tipTarget(container.querySelector('b'))).toBeNull()
  })

  it('mouse: aparece rápido (SHOW_MS), troca o texto ao vivo e some ao sair', () => {
    const { container } = render(
      <>
        <button type="button" data-tip="4 buscas">
          4
        </button>
        <HoverTipLayer />
      </>
    )
    const btn = container.querySelector('button')!
    over(btn)
    expect(document.querySelector('.hover-tip')).toBeNull()
    act(() => vi.advanceTimersByTime(SHOW_MS))
    const tip = document.querySelector('.hover-tip')
    expect(tip?.textContent).toBe('4 buscas')
    expect(tip?.getAttribute('role')).toBe('tooltip')
    fireEvent.pointerOut(btn, { pointerType: 'mouse', bubbles: true, relatedTarget: document.body })
    expect(document.querySelector('.hover-tip')).toBeNull()
  })

  it('toque longo no celular mostra o balão e não vira clique; toque curto é clique normal', () => {
    const onClick = vi.fn()
    const { container } = render(
      <>
        <button type="button" data-tip="1 subagente" onClick={onClick}>
          1
        </button>
        <HoverTipLayer />
      </>
    )
    const btn = container.querySelector('button')!
    fireEvent.pointerDown(btn, { pointerType: 'touch', bubbles: true, clientX: 5, clientY: 5 })
    act(() => vi.advanceTimersByTime(400))
    expect(document.querySelector('.hover-tip')?.textContent).toBe('1 subagente')
    fireEvent.pointerUp(btn, { pointerType: 'touch', bubbles: true })
    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(2000))
    expect(document.querySelector('.hover-tip')).toBeNull()

    fireEvent.pointerDown(btn, { pointerType: 'touch', bubbles: true, clientX: 5, clientY: 5 })
    act(() => vi.advanceTimersByTime(100))
    fireEvent.pointerUp(btn, { pointerType: 'touch', bubbles: true })
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.hover-tip')).toBeNull()
  })
})
