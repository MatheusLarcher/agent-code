import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { listener } from './engineTypes'
import { HOVER_PICK_MS, PointerInput, type PointerHooks } from './pointerInput'

function setup(under: (x: number) => string | null = (x) => (x < 0 ? 'conv:a' : null)) {
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
  let now = 0
  const hooks = {
    pick: vi.fn((x: number) => under(x)),
    drag: vi.fn(),
    click: vi.fn(),
    open: vi.fn(),
    zoom: vi.fn(),
    hover: vi.fn(),
    now: () => now
  } satisfies PointerHooks
  const cleanups: Array<() => void> = []
  const input = new PointerInput(canvas, listener(cleanups), hooks)
  return {
    canvas,
    hooks,
    input,
    wait: (ms: number) => void (now += ms),
    dispose: () => {
      for (const off of cleanups.splice(0)) off()
      canvas.remove()
    }
  }
}

afterEach(() => vi.restoreAllMocks())

describe('PointerInput', () => {
  it('hover: pick em coordenadas normalizadas, só avisa quando muda; no máximo a cada HOVER_PICK_MS (o atrasado sai no flush); sair do canvas dá null', () => {
    const s = setup()
    fireEvent.pointerMove(s.canvas, { clientX: 20, clientY: 50 })
    expect(s.hooks.pick).toHaveBeenLastCalledWith(-0.8, 0)
    expect(s.hooks.hover).toHaveBeenLastCalledWith('conv:a')
    expect(s.canvas.style.cursor).toBe('pointer')
    fireEvent.pointerMove(s.canvas, { clientX: 30, clientY: 50 })
    expect(s.hooks.pick).toHaveBeenCalledTimes(1) // dentro do intervalo
    fireEvent.pointerMove(s.canvas, { clientX: 150, clientY: 50 })
    expect(s.hooks.hover).toHaveBeenCalledTimes(1)
    s.wait(HOVER_PICK_MS)
    s.input.flushHover() // o tique do motor confere o último movimento
    expect(s.hooks.hover).toHaveBeenLastCalledWith(null)
    expect(s.canvas.style.cursor).toBe('')
    s.wait(HOVER_PICK_MS)
    fireEvent.pointerMove(s.canvas, { clientX: 10, clientY: 50 })
    expect(s.hooks.hover).toHaveBeenLastCalledWith('conv:a')
    fireEvent.pointerLeave(s.canvas)
    expect(s.hooks.hover).toHaveBeenLastCalledWith(null)
    expect(s.input.hover).toBeNull()
    s.dispose()
  })

  it('arrasto passa do clique e move a câmera (sem hover); clique curto seleciona; duplo clique abre; roda aproxima', () => {
    const s = setup()
    fireEvent.pointerMove(s.canvas, { clientX: 20, clientY: 50 })
    fireEvent.pointerDown(s.canvas, { button: 0, clientX: 20, clientY: 50 })
    expect(s.hooks.hover).toHaveBeenLastCalledWith(null)
    expect(s.input.dragging).toBe(true)
    fireEvent.pointerMove(window, { clientX: 22, clientY: 50 })
    expect(s.hooks.drag).not.toHaveBeenCalled() // ainda é clique
    fireEvent.pointerMove(window, { clientX: 40, clientY: 50 })
    expect(s.hooks.drag).toHaveBeenCalledWith('pan', 18, 0)
    fireEvent.pointerUp(window, { button: 0, clientX: 40, clientY: 50 })
    expect(s.hooks.click).not.toHaveBeenCalled()
    fireEvent.pointerDown(s.canvas, { button: 0, clientX: 20, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 21, clientY: 50 })
    expect(s.hooks.click).toHaveBeenCalledWith('conv:a', { x: 21, y: 50 })
    fireEvent.doubleClick(s.canvas, { clientX: 150, clientY: 50 })
    expect(s.hooks.open).toHaveBeenCalledWith(null)
    const wheel = new WheelEvent('wheel', { deltaY: 120, cancelable: true })
    s.canvas.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)
    expect(s.hooks.zoom).toHaveBeenCalledWith(120)
    s.input.reset()
    expect(s.input.dragging).toBe(false)
    s.dispose()
  })

  it('toque: dois dedos dão zoom pela proporção da pinça e giram juntos; o dedo que sobra não clica', () => {
    const s = setup()
    const touch = (type: 'pointerDown' | 'pointerMove' | 'pointerUp', id: number, x: number, y: number): void => {
      fireEvent[type](type === 'pointerDown' ? s.canvas : window, { pointerId: id, pointerType: 'touch', button: 0, clientX: x, clientY: y })
    }
    touch('pointerDown', 1, 50, 50)
    touch('pointerDown', 2, 150, 50)
    // Afastar os dedos (100 → 200 px): aproxima a câmera na mesma proporção (deltaY < 0).
    touch('pointerMove', 2, 250, 50)
    expect(s.hooks.zoom).toHaveBeenCalledTimes(1)
    expect(s.hooks.zoom.mock.calls[0][0]).toBeCloseTo(1000 * Math.log(100 / 200), 3)
    // O ponto médio andou (100 → 150): gira.
    expect(s.hooks.drag).toHaveBeenLastCalledWith('orbit', 50, 0)
    touch('pointerUp', 2, 250, 50)
    touch('pointerUp', 1, 50, 50)
    expect(s.hooks.click).not.toHaveBeenCalled()
    // Toque curto com o dedo tremendo um pouco (≤ 12 px) ainda é clique.
    touch('pointerDown', 3, 20, 50)
    touch('pointerMove', 3, 28, 50)
    touch('pointerUp', 3, 28, 50)
    expect(s.hooks.click).toHaveBeenCalledWith('conv:a', { x: 28, y: 50 })
    s.dispose()
  })
})
