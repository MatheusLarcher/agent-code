import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { OfficeFeed } from '../office/adapter/feed'
import { deriveOfficeModel } from '../office/adapter/model'
import { conv, feed } from '../office/adapter/testFeed'
import type { UIMessage } from '../types'
import { UiProvider } from '../ui/UiProvider'
import { PREVIEW_DELAY_MS, PREVIEW_MESSAGES } from './ChatPreview'
import { PROJECTOR_KEY, type EngineOptions, type FeedSource, type RendererLike } from './engineTypes'
import { layoutOffice } from './layout'
import { Office3DWorkspace, type Office3DWorkspaceProps } from './Office3DWorkspace'
import { Projectors } from './projectors'
import { OfficeScene } from './scene'
import { fakeBrowserApi, jpegFrame } from './testBrowserApi'

const NOW = Date.now()
const URL = 'http://localhost:5173/carrinho'
const renderer = (): RendererLike => ({ setPixelRatio() {}, setSize() {}, render() {}, dispose() {} })
const source = (f: OfficeFeed): FeedSource => ({ getSnapshot: () => f, subscribe: () => () => {} })

/** Turno longo (pedido + 8 ferramentas) e o navegador no fim: a prévia mostra só o fim. */
function turn(): UIMessage[] {
  const out: UIMessage[] = [{ kind: 'user', id: 'u1', text: 'confere o carrinho no navegador' }]
  for (let i = 0; i < 8; i++) out.push({ kind: 'tool-use', id: `r${i}`, name: 'Read', input: { file_path: `C:\\p\\f${i}.ts` }, parentToolUseId: null, result: { isError: false, text: 'ok' } })
  out.push({ kind: 'tool-use', id: 'n1', name: 'mcp__browser__browser_navigate', input: { url: URL }, parentToolUseId: null, result: { isError: false, text: `Navegou para ${URL} — "Carrinho" (aba: "web - Carrinho").` } })
  out.push({ kind: 'tool-use', id: 's1', name: 'mcp__browser__browser_screenshot', input: {}, parentToolUseId: null })
  return out
}
const testingFeed = (): OfficeFeed => feed({ conversations: [conv('a', { title: 'Carrinho no navegador', messages: turn(), updatedAt: NOW })], busyIds: new Set(['a']), activeId: 'a' })

/** RAF manual: os quadros só rodam quando o teste manda. */
function manualRaf(): { opts: Pick<EngineOptions, 'raf' | 'caf' | 'now'>; flush(n?: number): void } {
  let t = 0
  let next = 1
  const queue = new Map<number, FrameRequestCallback>()
  return {
    opts: { raf: (cb) => (queue.set(next, cb), next++), caf: (id) => void queue.delete(id), now: () => t },
    flush(n = 1) {
      for (let i = 0; i < n; i++) {
        t += 100
        const batch = [...queue.values()]
        queue.clear()
        for (const cb of batch) cb(t)
      }
    }
  }
}

function mount(props: Partial<Office3DWorkspaceProps> = {}, f = testingFeed()) {
  const raf = manualRaf()
  const api = fakeBrowserApi()
  const all: Office3DWorkspaceProps = {
    chat: null,
    onOpenConversation: vi.fn(),
    engineOptions: { ...raf.opts, source: source(f), createRenderer: renderer, browser: api },
    ...props
  }
  const view = render(
    <UiProvider>
      <Office3DWorkspace {...all} />
    </UiProvider>
  )
  act(() => raf.flush())
  const key = layoutOffice(deriveOfficeModel(f, NOW)).characters[0].key
  return { view, raf, api, key, canvas: screen.getByTestId('office3d-canvas'), all }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Prévia do agente ao passar o mouse', () => {
  it(`depois de ${PREVIEW_DELAY_MS} ms parado no agente: o cartão com o título e as últimas entradas no formato do chat; sair esconde na hora`, () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pick = vi.spyOn(OfficeScene.prototype, 'pick')
    const s = mount()
    pick.mockReturnValue(s.key)
    fireEvent.pointerMove(s.canvas, { clientX: 40, clientY: 40 })
    act(() => void vi.advanceTimersByTime(PREVIEW_DELAY_MS - 10))
    expect(screen.queryByTestId('office-preview')).toBeNull()
    act(() => void vi.advanceTimersByTime(10))
    const card = screen.getByTestId('office-preview')
    expect(card.querySelector('.o3d-turn-title')?.textContent).toBe('Carrinho no navegador')
    // No formato do chat resumido: o pedido e a resposta (sem texto) com a linha-resumo
    // recolhida (o "agora" fica só na linha ao vivo, sem duplicar) — os cartões só abrem ao clique (aqui, só leitura).
    expect(card.querySelector('.msg.user')?.textContent).toContain('confere o carrinho')
    const line = card.querySelector<HTMLElement>('.chat-step .central-act')
    expect(line?.classList.contains('running')).toBe(true)
    expect(line?.querySelector('.central-sum')?.textContent).toBe('Leu 8 arquivos · testou no navegador')
    expect(line?.querySelector('.central-spin')).toBeNull()
    expect(card.querySelector('.chat-live-text')?.textContent).toBe('Testando no navegador…')
    // As pílulas contam as 10 ações por tipo (o "N ações" saiu da linha do chat).
    const pills = [...(line?.querySelectorAll('.chat-pill b') ?? [])].map((b) => Number(b.textContent))
    expect(pills.reduce((a, b) => a + b, 0)).toBe(10)
    expect(card.querySelector('.tool-card')).toBeNull()
    // Até PREVIEW_MESSAGES linhas: este turno cabe inteiro (sem o aviso das de cima).
    expect(card.querySelectorAll('.message-list > *').length).toBeLessThanOrEqual(PREVIEW_MESSAGES + 1)
    expect(card.querySelector('.load-more-hint')).toBeNull()
    // Só leitura e sem pegar o mouse; posição pelo motor (transform), no próximo quadro.
    expect(card.getAttribute('aria-hidden')).toBe('true')
    const anchor = card.parentElement as HTMLElement
    act(() => s.raf.flush())
    expect(anchor.style.transform).toMatch(/^translate3d\(-?\d+px, -?\d+px, 0\)$/)
    fireEvent.pointerLeave(s.canvas)
    expect(screen.queryByTestId('office-preview')).toBeNull()
  })

  it('arrastar ou ir para a tela do projetor esconde; o agente com a tela aberta não tem prévia', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pick = vi.spyOn(OfficeScene.prototype, 'pick')
    const s = mount()
    pick.mockReturnValue(s.key)
    fireEvent.pointerMove(s.canvas, { clientX: 40, clientY: 40 })
    act(() => void vi.advanceTimersByTime(PREVIEW_DELAY_MS))
    expect(screen.getByTestId('office-preview')).toBeTruthy()
    fireEvent.pointerDown(s.canvas, { button: 0, clientX: 40, clientY: 40 })
    expect(screen.queryByTestId('office-preview')).toBeNull()
    fireEvent.pointerUp(window, { button: 0, clientX: 40, clientY: 40 }) // clique: abre a tela dele
    expect(screen.getByTestId('office-screen')).toBeTruthy()
    s.raf.flush(2)
    fireEvent.pointerMove(s.canvas, { clientX: 41, clientY: 40 })
    act(() => void vi.advanceTimersByTime(PREVIEW_DELAY_MS))
    expect(screen.queryByTestId('office-preview')).toBeNull()
    pick.mockReturnValue(`${PROJECTOR_KEY}sala`)
    s.raf.flush(2)
    fireEvent.pointerMove(s.canvas, { clientX: 60, clientY: 40 })
    act(() => void vi.advanceTimersByTime(PREVIEW_DELAY_MS))
    expect(screen.queryByTestId('office-preview')).toBeNull()
  })
})

describe('Quadros do navegador no motor', () => {
  it('liga onBrowserFrame/onBrowserState na montagem; aba fechada não desenha quadro; desmontar tira os ouvintes', () => {
    const arrived = vi.spyOn(Projectors.prototype, 'frameArrived')
    const s = mount()
    expect(s.api.listeners()).toBe(2)
    s.api.frame(jpegFrame())
    expect(arrived).toHaveBeenCalledWith('a')
    s.view.rerender(
      <UiProvider>
        <Office3DWorkspace {...s.all} active={false} />
      </UiProvider>
    )
    arrived.mockClear()
    s.api.frame(jpegFrame())
    expect(arrived).not.toHaveBeenCalled()
    s.view.unmount()
    expect(s.api.listeners()).toBe(0)
  })
})
