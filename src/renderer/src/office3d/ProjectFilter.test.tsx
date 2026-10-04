import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { syntheticFeed } from '../components/office/devFeed'
import { deriveOfficeModel } from '../office/adapter/model'
import { Office3DEngine, type EngineOptions, type RendererLike } from './engine'
import { FILTER_KEY } from './engineFilter'
import { layoutOffice } from './layout'
import { Office3DWorkspace } from './Office3DWorkspace'

const renderer = (): RendererLike => ({ setPixelRatio() {}, setSize() {}, render() {}, dispose() {} })
/** Sem laço de verdade: o filtro não depende de quadro. */
const RAF: Pick<EngineOptions, 'raf' | 'caf' | 'now'> = { raf: () => 0, caf: () => {}, now: () => 0 }

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('Escritório em aba: filtro de projeto no HUD', () => {
  it('filtro de projeto: Todos + projetos com agentes; a escolha vai ao motor, fica salva e volta depois de remontar (F5)', () => {
    localStorage.removeItem(FILTER_KEY)
    const feed = syntheticFeed()
    const projects = layoutOffice(deriveOfficeModel(feed, Date.now())).projects
    expect(projects.length).toBeGreaterThan(1)
    const set = vi.spyOn(Office3DEngine.prototype, 'setProjectFilter')
    const props = { chat: null, onOpenConversation: vi.fn(), onOpenFile: vi.fn(), engineOptions: { ...RAF, source: { getSnapshot: () => feed, subscribe: () => () => {} }, createRenderer: renderer } }
    const view = render(<Office3DWorkspace {...props} />)
    const pill = screen.getByRole('button', { name: 'Projeto no escritório: Todos' })
    expect(pill.closest('.o3d-hud')).toBe(screen.getByTestId('o3d-hud'))
    fireEvent.click(pill)
    const items = screen.getAllByRole('menuitemradio')
    expect(items.map((i) => i.querySelector('.o3d-pf-name')?.textContent)).toEqual(['Todos', ...projects.map((p) => p.name)])
    expect(items[0].getAttribute('aria-checked')).toBe('true')
    expect(items[1].textContent).toContain(`${projects[0].agents} agente`)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(pill)
    fireEvent.click(screen.getAllByRole('menuitemradio')[2])
    expect(set).toHaveBeenLastCalledWith(projects[1].id)
    expect(localStorage.getItem(FILTER_KEY)).toBe(projects[1].id)
    expect(screen.getByRole('button', { name: `Projeto no escritório: ${projects[1].name}` })).toBeTruthy()
    view.unmount()
    render(<Office3DWorkspace {...props} />)
    expect(screen.getByRole('button', { name: `Projeto no escritório: ${projects[1].name}` })).toBeTruthy()
    localStorage.removeItem(FILTER_KEY)
  })
})
