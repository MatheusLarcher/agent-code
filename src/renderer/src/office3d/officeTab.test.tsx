import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MainTabs } from '../components/MainTabs'
import { syntheticFeed } from '../components/office/devFeed'
import type { OfficeFeed } from '../office/adapter/feed'
import { deriveOfficeModel } from '../office/adapter/model'
import { seedColor, seedCss } from './appearance'
import { Office3DEngine, type EngineOptions, type FeedSource, type RendererLike } from './engine'
import { layoutOffice } from './layout'
import { OFFICE_CHAT_MIN_TOP, officeChatTop } from './OfficeChatFloat'
import { Office3DWorkspace, type Office3DWorkspaceProps } from './Office3DWorkspace'
import { OfficeScene } from './scene'
import { BUBBLE_TOP } from './speech'

function fakeRenderer(): RendererLike & { renders: number; disposed: boolean } {
  return {
    renders: 0,
    disposed: false,
    setPixelRatio() {},
    setSize() {},
    render() {
      this.renders++
    },
    dispose() {
      this.disposed = true
    }
  }
}

function source(feed: OfficeFeed | null): FeedSource & { subs: number; emit(f: OfficeFeed): void } {
  const subs = new Set<(f: OfficeFeed) => void>()
  return {
    getSnapshot: () => feed,
    subscribe(cb) {
      subs.add(cb)
      return () => void subs.delete(cb)
    },
    get subs() {
      return subs.size
    },
    emit(f) {
      for (const cb of subs) cb(f)
    }
  }
}

/** RAF manual: os quadros só rodam quando o teste manda. */
function manualRaf(): { opts: Pick<EngineOptions, 'raf' | 'caf' | 'now'>; flush(n?: number): void; pending(): number } {
  let t = 0
  let next = 1
  const queue = new Map<number, FrameRequestCallback>()
  return {
    opts: { raf: (cb) => (queue.set(next, cb), next++), caf: (id) => void queue.delete(id), now: () => t },
    flush(n = 1) {
      for (let i = 0; i < n; i++) {
        t += 16
        const batch = [...queue.values()]
        queue.clear()
        for (const cb of batch) cb(t)
      }
    },
    pending: () => queue.size
  }
}

/**
 * Listeners vivos em window e document (adicionados e ainda não removidos).
 * O 'selectionchange' que o React põe no document uma vez por documento fica de fora.
 */
function liveListeners(): { count(): number } {
  const live = new Set<string>()
  const ids = new WeakMap<object, number>()
  let n = 0
  const key = (target: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions): string | null => {
    if ((target !== window && target !== document) || !fn || type === 'selectionchange') return null
    if (!ids.has(fn)) ids.set(fn, ++n)
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture
    return `${target === window ? 'w' : 'd'}:${type}:${ids.get(fn)}:${capture}`
  }
  const add = EventTarget.prototype.addEventListener
  const remove = EventTarget.prototype.removeEventListener
  vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (this: EventTarget, type, fn, opts) {
    const k = key(this, type, fn, opts)
    if (k) live.add(k)
    add.call(this, type, fn, opts)
  })
  vi.spyOn(EventTarget.prototype, 'removeEventListener').mockImplementation(function (this: EventTarget, type, fn, opts) {
    const k = key(this, type, fn, opts)
    if (k) live.delete(k)
    remove.call(this, type, fn, opts)
  })
  return { count: () => live.size }
}

const CONV = (id: string): { id: string; title: string; cwd: string } => {
  const r = id.split('-')[1]
  return { id, title: `Conversa ${id}`, cwd: `C:\\dev\\projeto-${Number(r) + 1}` }
}

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
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('Escritório em aba: pausado com a aba fechada', () => {
  it('alternar 5×: um motor só, sem RAF nem tique com a aba fechada, sem listener a mais; desmontar libera tudo', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const live = liveListeners()
    const renderers: Array<ReturnType<typeof fakeRenderer>> = []
    const src = source(syntheticFeed())
    const raf = manualRaf()
    const opts: EngineOptions = { ...raf.opts, source: src, createRenderer: () => (renderers.push(fakeRenderer()), renderers[renderers.length - 1]) }
    const ui = (active: boolean): JSX.Element => (
      <Office3DWorkspace active={active} chat={active ? <div>chat</div> : null} conversation={CONV('dev-0-0')} onOpenConversation={vi.fn()} onOpenFile={vi.fn()} engineOptions={opts} />
    )
    const view = render(ui(true))
    act(() => raf.flush())
    const listeners = live.count()
    const timers = vi.getTimerCount()
    const canvas = screen.getByTestId('office3d-canvas')
    for (let i = 0; i < 5; i++) {
      view.rerender(ui(false))
      expect(screen.getByTestId('office3d-workspace').hidden).toBe(true)
      expect(raf.pending()).toBe(0)
      expect(vi.getTimerCount()).toBe(timers - 1)
      const renders = renderers[0].renders
      act(() => src.emit(syntheticFeed()))
      act(() => raf.flush(3))
      expect(renderers[0].renders).toBe(renders)
      view.rerender(ui(true))
      expect(screen.getByTestId('office3d-workspace').hidden).toBe(false)
      expect(raf.pending()).toBe(1)
      act(() => raf.flush())
      expect(renderers[0].renders).toBe(renders + 1)
      expect(vi.getTimerCount()).toBe(timers)
      expect(live.count()).toBe(listeners)
    }
    expect(renderers).toHaveLength(1)
    expect(screen.getByTestId('office3d-canvas')).toBe(canvas)
    expect(src.subs).toBe(1)
    view.unmount()
    expect(renderers[0].disposed).toBe(true)
    expect(src.subs).toBe(0)
    expect(raf.pending()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(live.count()).toBe(0)
  })
})

describe('Escritório em aba: o chat flutuante', () => {
  function renderOffice(props: Partial<Office3DWorkspaceProps> = {}) {
    const raf = manualRaf()
    const onOpenConversation = vi.fn()
    const all: Office3DWorkspaceProps = {
      chat: <textarea aria-label="mensagem" />,
      conversation: CONV('dev-0-0'),
      onOpenConversation,
      onOpenFile: vi.fn(),
      engineOptions: { ...raf.opts, source: source(syntheticFeed()), createRenderer: fakeRenderer },
      ...props
    }
    const view = render(<Office3DWorkspace {...all} />)
    act(() => raf.flush())
    return { view, raf, onOpenConversation, all, panel: (): HTMLElement => screen.getByRole('region', { name: 'Escritório' }) }
  }

  it('cabeçalho: ponto na cor da camisa do agente, título, projeto e 📍 que voa até a mesa dele', () => {
    const fly = vi.spyOn(Office3DEngine.prototype, 'flyToAgent')
    const { panel } = renderOffice()
    expect(panel().style.getPropertyValue('--o3d-agent')).toBe(seedCss('conv:dev-0-0'))
    // A cor que a tela mostra na camisa (a Color do three em sRGB), não um hsl() com os mesmos números.
    expect(seedCss('conv:dev-0-0')).toBe(seedColor('conv:dev-0-0').getStyle())
    expect(seedCss('conv:dev-0-0')).toMatch(/^rgb\(\d+,\d+,\d+\)$/)
    expect(screen.getByTestId('o3d-chat-dot')).toBeTruthy()
    expect(panel().querySelector('.o3d-chat-title')?.textContent).toBe('Conversa dev-0-0')
    expect(panel().querySelector('.o3d-chat-project')?.textContent).toBe('projeto-1')
    fireEvent.click(screen.getByRole('button', { name: 'Voar até a mesa do agente' }))
    expect(fly).toHaveBeenCalledWith('conv:dev-0-0', 'desk')
  })

  it('📍 com o chat maximizado: minimiza o chat (o agente fica no meio da tela, atrás dele) e voa', () => {
    const fly = vi.spyOn(Office3DEngine.prototype, 'flyToAgent')
    const { panel } = renderOffice()
    expect(panel().classList.contains('minimized')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Voar até a mesa do agente' }))
    expect(panel().classList.contains('minimized')).toBe(true)
    expect(localStorage.getItem('agentcode.office.chatMinimized')).toBe('1')
    expect(fly).toHaveBeenCalledWith('conv:dev-0-0', 'desk')
  })

  it('trocar de aba (ou clicar na barra lateral) não minimiza o chat nem grava nada; o palco 3D minimiza', () => {
    const raf = manualRaf()
    render(
      <div>
        <MainTabs active="office" onSelect={vi.fn()} />
        <nav>
          <button type="button">conversa da barra lateral</button>
        </nav>
        <Office3DWorkspace
          chat={<textarea aria-label="mensagem" />}
          conversation={CONV('dev-0-0')}
          onOpenConversation={vi.fn()}
          onOpenFile={vi.fn()}
          engineOptions={{ ...raf.opts, source: source(syntheticFeed()), createRenderer: fakeRenderer }}
        />
      </div>
    )
    const panel = (): HTMLElement => screen.getByRole('region', { name: 'Escritório' })
    for (const tab of screen.getAllByRole('tab')) fireEvent.pointerDown(tab, { button: 0 })
    fireEvent.pointerDown(screen.getByRole('button', { name: 'conversa da barra lateral' }), { button: 0 })
    expect(panel().classList.contains('minimized')).toBe(false)
    expect(localStorage.getItem('agentcode.office.chatMinimized')).toBeNull()
    fireEvent.pointerDown(screen.getByTestId('office3d-canvas'), { button: 0 })
    expect(panel().classList.contains('minimized')).toBe(true)
    expect(localStorage.getItem('agentcode.office.chatMinimized')).toBe('1')
  })

  it('translúcido como o do Planejamento: clicar fora (no canvas) minimiza e tira o foco; clicar nele expande; lembrado à parte', () => {
    const { panel } = renderOffice()
    expect(panel().classList.contains('pl-chat-float')).toBe(true)
    expect(panel().classList.contains('minimized')).toBe(false)
    const box = screen.getByLabelText('mensagem') as HTMLTextAreaElement
    box.focus()
    fireEvent.pointerDown(screen.getByTestId('office3d-canvas'), { button: 0 })
    expect(panel().classList.contains('minimized')).toBe(true)
    expect(document.activeElement).not.toBe(box)
    expect(localStorage.getItem('agentcode.office.chatMinimized')).toBe('1')
    expect(localStorage.getItem('agentcode.planning.chatMinimized')).toBeNull()
    // 📍 com o chat minimizado não o expande (quem pediu quer ver o agente).
    fireEvent.click(screen.getByRole('button', { name: 'Voar até a mesa do agente' }))
    expect(panel().classList.contains('minimized')).toBe(true)
    fireEvent.click(box)
    expect(panel().classList.contains('minimized')).toBe(false)
    expect(localStorage.getItem('agentcode.office.chatMinimized')).toBe('0')
  })

  it('duplo clique num agente seleciona a conversa dele e expande o chat', () => {
    localStorage.setItem('agentcode.office.chatMinimized', '1')
    const feed = syntheticFeed()
    const target = layoutOffice(deriveOfficeModel(feed, Date.now())).characters.find((c) => c.model.convId === 'dev-2-1')!
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(target.key)
    const { panel, onOpenConversation } = renderOffice()
    expect(panel().classList.contains('minimized')).toBe(true)
    fireEvent.doubleClick(screen.getByTestId('office3d-canvas'), { clientX: 40, clientY: 40 })
    expect(onOpenConversation).toHaveBeenCalledWith('dev-2-1')
    expect(panel().classList.contains('minimized')).toBe(false)
  })

  it('conversa trocada na sidebar com a aba aberta voa até o agente dela; com a aba fechada, não (nem ao voltar)', () => {
    const fly = vi.spyOn(Office3DEngine.prototype, 'flyToAgent')
    const { view, all } = renderOffice()
    expect(fly).not.toHaveBeenCalled()
    view.rerender(<Office3DWorkspace {...all} conversation={CONV('dev-1-0')} />)
    expect(fly).toHaveBeenCalledTimes(1)
    expect(fly).toHaveBeenLastCalledWith('conv:dev-1-0')
    view.rerender(<Office3DWorkspace {...all} active={false} chat={null} conversation={CONV('dev-2-0')} />)
    view.rerender(<Office3DWorkspace {...all} active conversation={CONV('dev-2-0')} />)
    expect(fly).toHaveBeenCalledTimes(1)
  })

  it('a 1ª conversa (o app carregou com a aba Escritório aberta) não leva a câmera: o prédio inteiro fica enquadrado', () => {
    const fly = vi.spyOn(Office3DEngine.prototype, 'flyToAgent')
    const { view, all } = renderOffice({ conversation: null })
    expect(screen.getByRole('region', { name: 'Escritório' }).querySelector('.o3d-chat-title')?.textContent).toBe('Nenhuma conversa')
    expect(screen.queryByRole('button', { name: 'Voar até a mesa do agente' })).toBeNull()
    view.rerender(<Office3DWorkspace {...all} conversation={CONV('dev-0-1')} />)
    expect(fly).not.toHaveBeenCalled()
  })

  it('id → null → id (apagou a última conversa e criou outra): a nova leva a câmera', () => {
    const fly = vi.spyOn(Office3DEngine.prototype, 'flyToAgent')
    const { view, all } = renderOffice()
    view.rerender(<Office3DWorkspace {...all} conversation={null} />)
    expect(fly).not.toHaveBeenCalled()
    view.rerender(<Office3DWorkspace {...all} conversation={CONV('dev-1-0')} />)
    expect(fly).toHaveBeenCalledTimes(1)
    expect(fly).toHaveBeenLastCalledWith('conv:dev-1-0')
  })

  it('WASD digitado no chat não anda pelo escritório (o motor não consome a tecla)', () => {
    renderOffice()
    const box = screen.getByLabelText('mensagem')
    box.focus()
    for (const key of ['w', 'a', 's', 'd']) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      box.dispatchEvent(ev)
      expect(ev.defaultPrevented).toBe(false)
    }
    // Fora de um campo de texto, a mesma tecla anda (e é consumida).
    const ev = new KeyboardEvent('keydown', { key: 'w', bubbles: true, cancelable: true })
    screen.getByTestId('office3d-canvas').dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('aba fechada: sem chat flutuante (o ChatPanel volta para o workspace)', () => {
    renderOffice({ active: false, chat: null })
    expect(screen.queryByRole('region', { name: 'Escritório' })).toBeNull()
  })

  it('a Central como conversa ativa: cabeçalho da Central (orbe, sem projeto nem 📍) e a câmera não voa para ela', () => {
    const fly = vi.spyOn(Office3DEngine.prototype, 'flyToAgent')
    const { view, all, panel } = renderOffice()
    view.rerender(<Office3DWorkspace {...all} conversation={{ id: 'central', title: 'Central', cwd: '' }} />)
    expect(fly).not.toHaveBeenCalled()
    expect(panel().querySelector('.o3d-chat-head .central-orb')).toBeTruthy()
    expect(panel().querySelector('.o3d-chat-title')?.textContent).toBe('Central')
    expect(panel().querySelector('.o3d-chat-project')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Voar até a mesa do agente' })).toBeNull()
    expect(panel().style.getPropertyValue('--o3d-agent')).toBe('var(--accent)')
  })
})

describe('Escritório em aba: o chat segue a mesa selecionada (sem mesa, a Central)', () => {
  /** Um principal que não é o da conversa ativa: o clique nele tem de trocar a conversa. */
  const TARGET = 'dev-2-1'
  function office(props: Partial<Office3DWorkspaceProps> = {}) {
    const feed = syntheticFeed()
    const target = layoutOffice(deriveOfficeModel(feed, Date.now())).characters.find((c) => c.model.convId === TARGET)!
    const pick = vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(target.key)
    const raf = manualRaf()
    const onOpenConversation = vi.fn()
    const all: Office3DWorkspaceProps = {
      chat: <div>chat</div>,
      central: <div>central</div>,
      conversation: CONV('dev-0-0'),
      onOpenConversation,
      engineOptions: { ...raf.opts, source: source(feed), createRenderer: fakeRenderer },
      ...props
    }
    const view = render(<Office3DWorkspace {...all} />)
    act(() => raf.flush())
    const canvas = screen.getByTestId('office3d-canvas')
    const click = (): void => {
      fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
      fireEvent.pointerUp(window, { button: 0, clientX: 50, clientY: 50 })
    }
    const shows = (): string | null | undefined => screen.getByRole('region', { name: 'Escritório' }).querySelector('.pl-chat-float-body')?.textContent
    const rerender = (p: Partial<Office3DWorkspaceProps>): void => view.rerender(<Office3DWorkspace {...all} {...p} />)
    return { raf, pick, onOpenConversation, canvas, click, shows, rerender, screenOpen: () => !!screen.queryByTestId('office-screen') }
  }

  it('sem mesa, a Central; clique no agente seleciona a conversa exata dele e mostra o chat; a conversa chegando não fecha a tela', () => {
    const o = office()
    expect(o.shows()).toBe('central')
    expect(screen.getByRole('region', { name: 'Escritório' }).querySelector('.o3d-chat-head .central-orb')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Voar até a mesa do agente' })).toBeNull()
    o.click()
    expect(o.onOpenConversation).toHaveBeenCalledWith(TARGET)
    expect(o.shows()).toBe('chat')
    // O App seleciona a conversa depois da folga do gesto: o follow dela não fecha a tela recém-aberta.
    act(() => o.raf.flush(130))
    o.rerender({ conversation: CONV(TARGET) })
    expect(o.screenOpen()).toBe(true)
    expect(o.shows()).toBe('chat')
    expect(screen.getByRole('button', { name: 'Voar até a mesa do agente' })).toBeTruthy()
  })

  it('Esc, clique no vazio, × da tela e roda do mouse voltam à Central sem trocar a conversa; duplo clique volta ao chat', () => {
    const o = office()
    const undo: Array<() => void> = [
      () => void fireEvent.keyDown(window, { key: 'Escape' }),
      () => {
        o.pick.mockReturnValueOnce(null)
        o.click()
      },
      () => void fireEvent.click(screen.getByRole('button', { name: 'Fechar a tela' })),
      () => void fireEvent.wheel(o.canvas, { deltaY: -120 })
    ]
    for (const run of undo) {
      o.click()
      expect(o.shows()).toBe('chat')
      act(run)
      expect(o.screenOpen()).toBe(false)
      expect(o.shows()).toBe('central')
    }
    expect(o.onOpenConversation.mock.calls).toEqual(undo.map(() => [TARGET]))
    fireEvent.doubleClick(o.canvas, { clientX: 50, clientY: 50 })
    expect(o.shows()).toBe('chat')
  })

  it('roda do mouse com o campo do chat focado: o campo perde o foco (o Composer grava o rascunho) antes de virar a Central', () => {
    const onBlur = vi.fn()
    const o = office({ chat: <textarea aria-label="mensagem" onBlur={onBlur} /> })
    o.click()
    act(() => (screen.getByLabelText('mensagem') as HTMLTextAreaElement).focus())
    fireEvent.wheel(o.canvas, { deltaY: -120 })
    expect(o.shows()).toBe('central')
    expect(onBlur).toHaveBeenCalledTimes(1)
  })

  it('conversa escolhida fora do 3D mostra o chat; o voo do follow que fecha a tela não volta à Central', () => {
    const fly = vi.spyOn(Office3DEngine.prototype, 'flyToAgent')
    const o = office()
    o.rerender({ conversation: CONV('dev-1-0') })
    expect(o.shows()).toBe('chat')
    o.click()
    act(() => o.raf.flush(130))
    o.rerender({ conversation: CONV('dev-3-0') })
    expect(fly).toHaveBeenLastCalledWith('conv:dev-3-0')
    expect(o.screenOpen()).toBe(false)
    expect(o.shows()).toBe('chat')
  })
})

describe('Escritório em aba: HUD', () => {
  it('a energia fica no canto esquerdo e o "?" abre a legenda das teclas (Esc e clique fora fecham)', () => {
    const raf = manualRaf()
    const feed = { ...syntheticFeed(), usageLimits: { five_hour: { rateLimitType: 'five_hour' as const, status: 'allowed' as const, utilization: 0.4, resetsAt: Date.now() + 3_600_000 } } }
    render(<Office3DWorkspace chat={null} onOpenConversation={vi.fn()} onOpenFile={vi.fn()} engineOptions={{ ...raf.opts, source: source(feed), createRenderer: fakeRenderer }} />)
    const hud = screen.getByTestId('o3d-hud')
    expect(hud.firstElementChild).toBe(screen.getByTestId('o3d-session-battery'))
    expect(screen.queryByText(/WASD anda/)).toBeNull()
    const help = screen.getByRole('button', { name: 'Controles do escritório' })
    expect(help.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(help)
    const pop = screen.getByRole('dialog', { name: 'Controles do escritório' })
    expect(pop.textContent).toContain('anda pelo escritório')
    expect([...pop.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(expect.arrayContaining(['W', 'A', 'S', 'D', 'Shift', 'Esc', '📍']))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Controles do escritório' })).toBeNull()
    fireEvent.click(help)
    fireEvent.pointerDown(screen.getByTestId('office3d-canvas'))
    expect(screen.queryByRole('dialog', { name: 'Controles do escritório' })).toBeNull()
  })

  it('Esc com a legenda aberta só fecha a legenda: a tela do monitor focada continua (o próximo Esc a fecha)', () => {
    const feed = syntheticFeed()
    const target = layoutOffice(deriveOfficeModel(feed, Date.now())).characters.find((c) => c.deskIndex !== null && c.model.active)!
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(target.key)
    const raf = manualRaf()
    render(<Office3DWorkspace chat={null} onOpenConversation={vi.fn()} onOpenFile={vi.fn()} engineOptions={{ ...raf.opts, source: source(feed), createRenderer: fakeRenderer }} />)
    const canvas = screen.getByTestId('office3d-canvas')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 50, clientY: 50 })
    expect(screen.getByTestId('office-screen')).toBeTruthy()
    const help = screen.getByRole('button', { name: 'Controles do escritório' })
    fireEvent.click(help)
    // A tecla nasce no elemento com foco (no navegador nunca na window).
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Controles do escritório' })).toBeNull()
    expect(screen.getByTestId('office-screen')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByTestId('office-screen')).toBeNull()
  })

  it('Controle do Windows ligado: o HUD mostra o aviso com "Desativar" (o mesmo handler do chat); desligado, nada', () => {
    const raf = manualRaf()
    const off = vi.fn()
    const props = { chat: null, onOpenConversation: vi.fn(), onOpenFile: vi.fn(), onDisableWindowsControl: off, engineOptions: { ...raf.opts, source: source(syntheticFeed()), createRenderer: fakeRenderer } }
    const view = render(<Office3DWorkspace {...props} windowsControlEnabled />)
    const chip = screen.getByTestId('o3d-windows-control')
    expect(chip.closest('.o3d-hud')).toBe(screen.getByTestId('o3d-hud'))
    expect(chip.textContent).toContain('Controle do Windows ativo')
    fireEvent.click(screen.getByRole('button', { name: 'Desativar' }))
    expect(off).toHaveBeenCalledTimes(1)
    view.rerender(<Office3DWorkspace {...props} windowsControlEnabled={false} />)
    expect(screen.queryByTestId('o3d-windows-control')).toBeNull()
  })

  it('o HUD cabe na faixa de cima que os balões não cruzam e o chat maximizado começa abaixo dela', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/office3d/office3d.css'), 'utf8')
    const block = (sel: string): string => {
      const start = css.indexOf(`\n${sel} {`)
      expect(start, sel).toBeGreaterThan(-1)
      return css.slice(start, css.indexOf('}', start))
    }
    const px = (b: string, prop: string): number => Number(new RegExp(`\\n\\s*${prop}: (\\d+)px;`).exec(b)?.[1])
    const hud = block('.o3d-hud')
    expect(px(hud, 'top') + px(hud, 'height')).toBeLessThanOrEqual(BUBBLE_TOP)
    expect(px(block('.o3d-battery'), 'height')).toBeLessThanOrEqual(px(hud, 'height'))
    expect(px(block('.o3d-winctl'), 'height')).toBeLessThanOrEqual(px(hud, 'height'))
    expect(px(block('.o3d-help-btn'), 'height')).toBeLessThanOrEqual(px(hud, 'height'))
    // Acima do chat flutuante (z-index 8 no planningChat.css): nada do HUD fica sob ele.
    expect(Number(/z-index: (\d+);/.exec(hud)?.[1])).toBeGreaterThan(8)
    expect(OFFICE_CHAT_MIN_TOP).toBeGreaterThan(BUBBLE_TOP)
    expect(officeChatTop({ viewportHeight: 300, areaTop: 52, areaRight: 1000, panelRight: 800 })).toBe(OFFICE_CHAT_MIN_TOP)
    expect(officeChatTop({ viewportHeight: 1000, areaTop: 52, areaRight: 1000, panelRight: 800 })).toBe(148)
  })
})
