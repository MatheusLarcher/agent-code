import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { OfficeFeed } from '../../office/adapter/feed'
import type { OfficeCharacterModel } from '../../office/adapter/model'
import { conv, feed } from '../../office/adapter/testFeed'
import type { UIMessage } from '../../types'
import { UiProvider } from '../../ui/UiProvider'
import { CodeMonitor } from './CodeMonitor'
import { HIDE_MS, REVEAL_MS } from './Taskbar'

const CWD = 'C:\\proj\\loja'
const model: OfficeCharacterModel = {
  key: 'conv:a', convId: 'a', roomId: 'c:/proj/loja', role: 'principal', placement: { kind: 'seat', seatKind: 'principal' },
  seed: 'conv:a', active: true, activity: null, bubble: null, label: 'Edit total.ts'
}
const ask: UIMessage = { kind: 'user', id: 'u', text: 'mexe no total' }
let seq = 0
const edit = (file: string, result = 'ok'): UIMessage => ({
  kind: 'tool-use', id: `e${seq++}`, name: 'Edit', input: { file_path: `${CWD}\\src\\${file}`, old_string: 'a', new_string: 'b' }, parentToolUseId: null, result: { isError: false, text: result }
})
const feedOf = (messages: UIMessage[], extra: Partial<OfficeFeed> = {}): OfficeFeed =>
  feed({ conversations: [conv('a', { title: 'Carrinho', cwd: CWD, messages })], busyIds: new Set(['a']), ...extra })
const ui = (f: OfficeFeed, onClose = vi.fn()): JSX.Element => (
  <UiProvider>
    <CodeMonitor feed={f} model={model} onClose={onClose} />
  </UiProvider>
)
const root = (): HTMLElement => screen.getByTestId('office-screen')
const app = (name: string): HTMLElement => screen.getByRole('button', { name })

beforeEach(() => {
  localStorage.clear()
  ;(window as unknown as { api: unknown }).api = { readFile: vi.fn(async () => 'a\n') }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

describe('CodeMonitor — barra de tarefas', () => {
  it('a barra tem só Código (com o Chat dentro) e Contexto, com Alt+1/Alt+2 no título, e marca o ativo', () => {
    render(ui(feedOf([ask, edit('total.ts')])))
    expect(root().querySelector('.cm-titlebar .cm-modes')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Chat' })).toBeNull()
    expect(['Código', 'Contexto'].map((n) => app(n).getAttribute('aria-pressed'))).toEqual(['true', 'false'])
    expect([app('Código').getAttribute('title'), app('Contexto').getAttribute('title')]).toEqual(['Código (Alt+1)', 'Contexto (Alt+2)'])
    fireEvent.click(app('Contexto'))
    expect([root().dataset.mode, root().dataset.kind, app('Contexto').getAttribute('aria-pressed')]).toEqual(['ctx', 'context', 'true'])
    fireEvent.click(app('Código'))
    expect(root().dataset.mode).toBe('code')
  })

  it('escondida por padrão, com a linha fina; a borda abre depois do atraso e afastar o mouse fecha', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    render(ui(feedOf([ask])))
    expect(root().classList.contains('tb-open')).toBe(false)
    expect(root().querySelectorAll('.cm-peek i')).toHaveLength(2)
    const zone = root().querySelector('.cm-tbzone')!
    fireEvent.mouseEnter(zone)
    act(() => void vi.advanceTimersByTime(REVEAL_MS - 1))
    expect(root().classList.contains('tb-open')).toBe(false)
    act(() => void vi.advanceTimersByTime(1))
    expect(root().classList.contains('tb-open')).toBe(true)
    // O mouse sobe para longe da barra (não depende de mouseleave).
    const bar = screen.getByRole('navigation', { name: 'Barra de tarefas do monitor' })
    bar.getBoundingClientRect = () => ({ top: 674, bottom: 720, height: 46, left: 0, right: 1280, width: 1280, x: 0, y: 674, toJSON: () => ({}) })
    fireEvent.mouseMove(root(), { clientY: 100 })
    act(() => void vi.advanceTimersByTime(HIDE_MS - 1))
    expect(root().classList.contains('tb-open')).toBe(true)
    act(() => void vi.advanceTimersByTime(1))
    expect(root().classList.contains('tb-open')).toBe(false)
  })

  it('abre por foco de teclado (Tab) na hora; a dica some para sempre depois de abrir', () => {
    render(ui(feedOf([ask])))
    expect(root().textContent).toContain('Leve o mouse até a borda de baixo')
    act(() => app('Contexto').focus())
    expect(root().classList.contains('tb-open')).toBe(true)
    expect(root().textContent).not.toContain('Leve o mouse até a borda de baixo')
    expect(localStorage.getItem('agentcode.monitor.coachSeen')).toBe('1')
    cleanup()
    render(ui(feedOf([ask])))
    expect(root().textContent).not.toContain('Leve o mouse até a borda de baixo')
  })

  it('alfinete fixa e o último app abre na próxima tela (localStorage)', () => {
    render(ui(feedOf([ask, edit('total.ts')])))
    fireEvent.click(screen.getByRole('button', { name: 'Fixar a barra' }))
    fireEvent.click(app('Contexto'))
    expect(root().classList.contains('pinned')).toBe(true)
    cleanup()
    render(ui(feedOf([ask, edit('total.ts')])))
    expect([root().classList.contains('pinned'), root().dataset.mode]).toEqual([true, 'ctx'])
    fireEvent.click(screen.getByRole('button', { name: 'Desafixar a barra' }))
    expect(root().classList.contains('pinned')).toBe(false)
  })

  it('Alt+1/2 trocam de app (Alt+3 já não é do monitor); Esc fecha o menu do Agent sem chegar ao motor', () => {
    const toEngine = vi.fn()
    window.addEventListener('keydown', toEngine)
    try {
      render(ui(feedOf([ask])))
      fireEvent.keyDown(window, { key: '2', altKey: true })
      expect(root().dataset.mode).toBe('ctx')
      fireEvent.keyDown(window, { key: '1', altKey: true })
      expect(root().dataset.mode).toBe('code')
      expect(toEngine).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Menu do Agent' }))
      expect(screen.getByRole('dialog', { name: 'Menu do Agent' })).toBeTruthy()
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(screen.queryByRole('dialog', { name: 'Menu do Agent' })).toBeNull()
      expect(toEngine).not.toHaveBeenCalled()
      fireEvent.keyDown(window, { key: '3', altKey: true })
      expect(root().dataset.mode).toBe('code')
    } finally {
      window.removeEventListener('keydown', toEngine)
    }
  })

  it('selos: Código = alterados e "trabalhando"; esperando permissão, o Código pisca em âmbar com "!", o Chat diz "aguardando você" e o aviso (que leva ao Código) fica até a resposta', () => {
    const view = render(ui(feedOf([ask, edit('a.ts'), edit('b.ts')])))
    expect(app('Código').querySelector('.cm-tb-badge')?.textContent).toBe('2')
    expect(app('Código').querySelector('.cm-busydot')).toBeTruthy()
    const perm = { a: { id: 'p1', toolName: 'Bash', input: { command: 'npm test' } } }
    view.rerender(ui(feedOf([ask, edit('a.ts'), edit('b.ts')], { permissions: perm })))
    expect(app('Código').classList.contains('att')).toBe(true)
    expect(app('Código').querySelector('.cm-tb-badge.warn')?.textContent).toBe('!')
    expect(app('Código').querySelector('.cm-busydot')).toBeNull()
    expect(root().querySelector('.cm-peek i.att')).toBeTruthy()
    expect(screen.getByTestId('office-screen-chat').querySelector('.cm-chat-state')?.textContent).toBe('aguardando você')
    expect(root().querySelector('.cm-toast.warn')?.textContent).toContain('O Agent precisa de você')
    fireEvent.click(app('Contexto'))
    fireEvent.click(root().querySelector('.cm-toast.warn')!)
    expect(root().dataset.mode).toBe('code')
    view.rerender(ui(feedOf([ask, edit('a.ts'), edit('b.ts')])))
    expect(root().querySelector('.cm-toast.warn')).toBeNull()
    expect(app('Código').classList.contains('att')).toBe(false)
  })

  it('avisos: arquivo alterado com a tela aberta (clique abre no Código) e fim do turno; o que já estava não avisa', () => {
    const view = render(ui(feedOf([ask, edit('velho.ts')])))
    expect(root().querySelectorAll('.cm-toast')).toHaveLength(0)
    fireEvent.click(app('Contexto'))
    view.rerender(ui(feedOf([ask, edit('velho.ts'), edit('novo.ts')])))
    const toast = [...root().querySelectorAll<HTMLElement>('.cm-toast')].find((t) => t.textContent?.includes('O Agent alterou novo.ts'))!
    expect(toast).toBeTruthy()
    fireEvent.click(toast)
    expect(root().dataset.mode).toBe('code')
    expect(screen.getByRole('tab', { name: 'novo.ts, modificado' }).getAttribute('aria-selected')).toBe('true')
    view.rerender(ui(feedOf([ask, edit('velho.ts'), edit('novo.ts')], { busyIds: new Set() })))
    expect(root().textContent).toContain('Turno terminado')
  })

  it('menu do Agent: modelo da sessão, esforço e os modelos do turno com as chamadas (do histórico)', async () => {
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      readFile: vi.fn(async () => 'a\n'),
      listContextTurns: vi.fn(async () => [{ turnId: 'T', models: [{ model: 'claude-opus-5-5', calls: 13, node: null }, { model: 'gpt-6.1-sol', calls: 4, node: null }, { model: 'claude-opus-5-5', calls: 2, node: 'task' }] }])
    }
    const sys: UIMessage = { kind: 'system', sessionId: 's', model: 'claude-opus-5-5', cwd: CWD, tools: [], effort: 'max' }
    render(ui(feedOf([sys, ask])))
    fireEvent.click(screen.getByRole('button', { name: 'Menu do Agent' }))
    const menu = screen.getByRole('dialog', { name: 'Menu do Agent' })
    expect(menu.textContent).toContain('Opus 5.5 · esforço máximo')
    await screen.findByText('Opus 5.5 · 15 chamadas')
    expect(menu.textContent).toContain('GPT-6.1 Sol · 4 chamadas')
    expect(menu.textContent).not.toContain('Automático')
  })
})
