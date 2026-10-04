import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { conv, feed } from '../office/adapter/testFeed'
import type { UIMessage } from '../types'
import { Office3DEngine, type FeedSource, type RendererLike } from './engine'
import { PROJECTOR_KEY } from './engineTypes'
import { OFFICE_ID } from './layout'
import { callMarks } from './officeCalls'
import { Office3DWorkspace } from './Office3DWorkspace'
import { OfficeScene } from './scene'

const NOW = Date.now()
const CALL_ID = `call-tv-${NOW}`
const MSGS: UIMessage[] = [
  { kind: 'user', id: 'u1', text: 'faz a tela de login' },
  { kind: 'tool-use', id: CALL_ID, name: 'mcp__app__app_chamar_usuario', input: { arquivo: 'tela.html', mensagem: 'Pronta!' }, parentToolUseId: null, result: { isError: false, text: 'ok' } }
]

const renderer = (): RendererLike => ({ setPixelRatio() {}, setSize() {}, render() {}, dispose() {} })
const source = (f: ReturnType<typeof feed>): FeedSource => ({ getSnapshot: () => f, subscribe: () => () => {} })
function manualRaf() {
  let t = 0
  let next = 1
  const queue = new Map<number, FrameRequestCallback>()
  return {
    opts: { raf: (cb: FrameRequestCallback) => (queue.set(next, cb), next++), caf: (id: number) => void queue.delete(id), now: () => t },
    flush(n = 1) {
      for (let i = 0; i < n; i++) {
        t += 16
        const batch = [...queue.values()]
        queue.clear()
        for (const cb of batch) cb(t)
      }
    }
  }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('api', { officeMockupUrl: vi.fn(async () => ({ ok: true, url: 'agent-mockup://t/tela.html' })) })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('clique na TV: o foco dentro dela', () => {
  it('voa de frente e abre o mockup de quem chama (o chamado acaba: foi visto); sem clique no voo; Aprovar manda para a conversa e fecha; o chat flutuante sai', async () => {
    const f = feed({ conversations: [conv('a', { messages: MSGS, updatedAt: NOW })], activeId: 'a' })
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(`${PROJECTOR_KEY}${OFFICE_ID}`)
    const raf = manualRaf()
    const send = vi.fn()
    render(
      <Office3DWorkspace
        chat={<div data-testid="chat-float">chat</div>}
        onOpenConversation={vi.fn()}
        onSendToConversation={send}
        engineOptions={{ ...raf.opts, source: source(f), createRenderer: renderer, browser: null }}
      />
    )
    expect(screen.getByTestId('chat-float')).toBeTruthy()
    const canvas = screen.getByTestId('office3d-canvas')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 51, clientY: 50 })
    const tv = screen.getByTestId('tv-focus')
    expect(tv.dataset.kind).toBe('mockup')
    expect(callMarks.ended(CALL_ID)).toBe(true)
    expect(screen.queryByTestId('chat-float')).toBeNull()
    const anchor = tv.parentElement as HTMLElement
    act(() => raf.flush(2))
    expect(anchor.style.pointerEvents).toBe('none') // no voo
    act(() => raf.flush(40))
    expect(anchor.style.pointerEvents).toBe('')
    expect(anchor.style.width).toMatch(/px$/)
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    expect(screen.getByTestId('tv-focus-iframe').getAttribute('sandbox')).toBe('allow-scripts')
    fireEvent.click(screen.getByRole('button', { name: 'Aprovar' }))
    expect(send).toHaveBeenCalledWith('a', 'Aprovado: tela.html')
    expect(screen.queryByTestId('tv-focus')).toBeNull()
    expect(screen.getByTestId('chat-float')).toBeTruthy()
  })

  it('clique na notificação (callSignal): o filtro vai para o projeto do chamado e a câmera voa de frente para a TV, sem abrir o foco', () => {
    const f = feed({ conversations: [conv('a', { messages: MSGS, updatedAt: NOW })], activeId: 'a' })
    const filter = vi.spyOn(Office3DEngine.prototype, 'setProjectFilter')
    const fly = vi.spyOn(Office3DEngine.prototype, 'flyToPose')
    const raf = manualRaf()
    const props = { chat: null, onOpenConversation: vi.fn(), engineOptions: { ...raf.opts, source: source(f), createRenderer: renderer, browser: null } }
    const v = render(<Office3DWorkspace {...props} callSignal={{ n: 0, projectId: null }} />)
    v.rerender(<Office3DWorkspace {...props} callSignal={{ n: 1, projectId: 'proj-a' }} />)
    expect(filter).toHaveBeenCalledWith('proj-a')
    expect(fly).toHaveBeenCalledTimes(1)
    expect(fly.mock.calls[0][0]).toMatchObject({ yaw: 0, pitch: 0 })
    expect(screen.queryByTestId('tv-focus')).toBeNull()
  })

  it('o placar abre como espelho; Esc volta', () => {
    const f = feed({ conversations: [conv('b', { messages: [], updatedAt: NOW })], activeId: 'b' })
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(`${PROJECTOR_KEY}${OFFICE_ID}`)
    const raf = manualRaf()
    render(<Office3DWorkspace chat={null} onOpenConversation={vi.fn()} engineOptions={{ ...raf.opts, source: source(f), createRenderer: renderer, browser: null }} />)
    const canvas = screen.getByTestId('office3d-canvas')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 51, clientY: 50 })
    expect(screen.getByTestId('tv-focus').dataset.kind).toBe('score')
    expect(screen.getByTestId('tv-focus-mirror')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('tv-focus')).toBeNull()
  })
})
