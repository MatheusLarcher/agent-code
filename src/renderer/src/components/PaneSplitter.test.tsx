import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { clampPane, PaneSplitter, type PaneSplitterProps } from './PaneSplitter'

afterEach(cleanup)

/** O painel controlado como quem usa: a largura sobe a cada passo. */
function Harness(p: Partial<PaneSplitterProps> & { start?: number; onCommit: (w: number) => void; onResize?: (w: number) => void }): JSX.Element {
  const [w, setW] = useState(p.start ?? 400)
  return (
    <PaneSplitter
      width={w}
      min={p.min ?? 280}
      getMax={p.getMax ?? (() => 768)}
      side={p.side ?? 'end'}
      label="Largura do chat"
      onResize={(next) => {
        setW(next)
        p.onResize?.(next)
      }}
      onCommit={p.onCommit}
    />
  )
}

function mount(p: Partial<PaneSplitterProps> & { start?: number } = {}) {
  const onResize = vi.fn()
  const onCommit = vi.fn()
  render(<Harness {...p} onResize={onResize} onCommit={onCommit} />)
  return { sep: screen.getByRole('separator', { name: 'Largura do chat' }), onResize, onCommit }
}

describe('clampPane', () => {
  it('entre o mínimo e o máximo, em px inteiros; máximo abaixo do mínimo vale o mínimo; sem medida (Infinity), só o mínimo', () => {
    expect(clampPane(100, 280, 768)).toBe(280)
    expect(clampPane(900, 280, 768)).toBe(768)
    expect(clampPane(400.6, 280, 768)).toBe(401)
    expect(clampPane(500, 280, 200)).toBe(280)
    expect(clampPane(2000, 280, Infinity)).toBe(2000)
  })
})

describe('PaneSplitter (painel à direita: cresce para a esquerda)', () => {
  it('puxar para a esquerda alarga e para a direita estreita; cada passo avisa, só o fim do arrasto grava; a largura aparece durante o arrasto', () => {
    const { sep, onResize, onCommit } = mount()
    fireEvent.pointerDown(sep, { clientX: 880, button: 0, pointerId: 1 })
    expect(sep.classList.contains('dragging')).toBe(true)
    fireEvent.pointerMove(sep, { clientX: 820, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(460)
    expect(sep.textContent).toBe('460 px')
    fireEvent.pointerMove(sep, { clientX: 900, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(380)
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.pointerUp(sep, { clientX: 900, pointerId: 1 })
    expect(onCommit).toHaveBeenCalledWith(380)
    expect(sep.classList.contains('dragging')).toBe(false)
    expect(sep.textContent).toBe('')
  })

  it('o arrasto para no máximo (lido na hora) e no mínimo', () => {
    let max = 768
    const { sep, onResize, onCommit } = mount({ getMax: () => max })
    fireEvent.pointerDown(sep, { clientX: 880, button: 0, pointerId: 1 })
    fireEvent.pointerMove(sep, { clientX: 0, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(768)
    max = 600
    fireEvent.pointerMove(sep, { clientX: 10, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(600)
    fireEvent.pointerMove(sep, { clientX: 2000, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(280)
    fireEvent.pointerUp(sep, { pointerId: 1 })
    expect(onCommit).toHaveBeenCalledWith(280)
  })

  it('mover sem ter apertado não redimensiona; botão direito não começa arrasto', () => {
    const { sep, onResize } = mount()
    fireEvent.pointerMove(sep, { clientX: 100, pointerId: 1 })
    fireEvent.pointerDown(sep, { clientX: 880, button: 2, pointerId: 1 })
    fireEvent.pointerMove(sep, { clientX: 700, pointerId: 1 })
    expect(onResize).not.toHaveBeenCalled()
  })

  it('tela transformada (escala 0,5): o delta do mouse vale o dobro em px de layout', () => {
    const { sep, onResize } = mount()
    const host = sep.parentElement!
    Object.defineProperty(host, 'offsetWidth', { configurable: true, value: 1000 })
    host.getBoundingClientRect = () => ({ width: 500, height: 0, top: 0, left: 0, right: 500, bottom: 0, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.pointerDown(sep, { clientX: 500, button: 0, pointerId: 1 })
    fireEvent.pointerMove(sep, { clientX: 470, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(460)
  })

  it('teclado: ← alarga e → estreita de 16 em 16; Home = mínimo; End = máximo; cada tecla grava', () => {
    const { sep, onCommit } = mount()
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    expect(onCommit).toHaveBeenLastCalledWith(416)
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    expect(onCommit).toHaveBeenLastCalledWith(384)
    fireEvent.keyDown(sep, { key: 'End' })
    expect(onCommit).toHaveBeenLastCalledWith(768)
    fireEvent.keyDown(sep, { key: 'Home' })
    expect(onCommit).toHaveBeenLastCalledWith(280)
    onCommit.mockClear()
    fireEvent.keyDown(sep, { key: 'a' })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('área não medida: End não faz nada (sem máximo) e as setas só respeitam o mínimo', () => {
    const { sep, onCommit } = mount({ getMax: () => Infinity })
    fireEvent.keyDown(sep, { key: 'End' })
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    expect(onCommit).toHaveBeenLastCalledWith(416)
    expect(sep.getAttribute('aria-valuemax')).toBeNull()
  })

  it('anuncia a largura e os limites para leitor de tela', () => {
    const { sep } = mount({ start: 440 })
    expect(sep.getAttribute('aria-orientation')).toBe('vertical')
    expect(sep.getAttribute('aria-valuenow')).toBe('440')
    expect(sep.getAttribute('aria-valuemin')).toBe('280')
    expect(sep.getAttribute('aria-valuemax')).toBe('768')
    expect(sep.getAttribute('tabindex')).toBe('0')
  })
})

describe('PaneSplitter (painel à esquerda: cresce para a direita)', () => {
  it('puxar para a direita alarga; → alarga e ← estreita', () => {
    const { sep, onResize, onCommit } = mount({ side: 'start', start: 300 })
    fireEvent.pointerDown(sep, { clientX: 300, button: 0, pointerId: 1 })
    fireEvent.pointerMove(sep, { clientX: 350, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(350)
    fireEvent.pointerUp(sep, { pointerId: 1 })
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    expect(onCommit).toHaveBeenLastCalledWith(366)
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    expect(onCommit).toHaveBeenLastCalledWith(350)
  })
})
