import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Mesh, MeshLambertMaterial, type Scene } from 'three'
import { syntheticFeed } from '../components/office/devFeed'
import type { OfficeFeed } from '../office/adapter/feed'
import { deriveOfficeModel } from '../office/adapter/model'
import { liveInput, type ToolInputDelta } from '../office/liveInput'
import { officeStore } from '../office/officeStore'
import { UiProvider } from '../ui/UiProvider'
import { DEMO_TICK_MS } from './demoFeed'
import { DEMO_LOOP_MS } from './demoTimeline'
import { Office3DEngine, type EngineOptions, type FeedSource, type RendererLike } from './engine'
import { layoutOffice } from './layout'
import { Office3DWorkspace } from './Office3DWorkspace'
import { OfficeScene } from './scene'

const observed: number[] = []
const disconnects: number[] = []
class RO {
  observe(): void {
    observed.push(1)
  }
  disconnect(): void {
    disconnects.push(1)
  }
}

function fakeRenderer(): RendererLike & { renders: number; disposed: boolean; ratio: number } {
  return {
    renders: 0,
    disposed: false,
    ratio: 0,
    setPixelRatio(r) {
      this.ratio = r
    },
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
function manualRaf(): { opts: Pick<EngineOptions, 'raf' | 'caf' | 'now'>; flush(n?: number): void; pending(): number; cancelled: number[] } {
  let t = 0
  let next = 1
  const queue = new Map<number, FrameRequestCallback>()
  const cancelled: number[] = []
  return {
    opts: {
      raf: (cb) => (queue.set(next, cb), next++),
      caf: (id) => {
        cancelled.push(id)
        queue.delete(id)
      },
      now: () => t
    },
    flush(n = 1) {
      for (let i = 0; i < n; i++) {
        t += 16
        const batch = [...queue.entries()]
        queue.clear()
        for (const [, cb] of batch) cb(t)
      }
    },
    pending: () => queue.size,
    cancelled
  }
}

beforeEach(() => {
  // A tela do monitor lembra o último app no localStorage: cada teste começa do zero.
  localStorage.clear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
  observed.length = 0
  disconnects.length = 0
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Office3DWorkspace', () => {
  it('monta, desmonta e remonta sem erro, limpando RAF, listeners, observer e renderer', () => {
    const renderers: Array<ReturnType<typeof fakeRenderer>> = []
    const src = source(syntheticFeed())
    const raf = manualRaf()
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const opts: EngineOptions = { ...raf.opts, source: src, createRenderer: () => (renderers.push(fakeRenderer()), renderers[renderers.length - 1]) }
    const props = { chat: <div>chat</div>, onOpenConversation: vi.fn(), onOpenFile: vi.fn(), engineOptions: opts }

    const first = render(<Office3DWorkspace {...props} />)
    expect(screen.getByText('chat')).toBeTruthy()
    expect(renderers[0].ratio).toBeLessThanOrEqual(2)
    expect(raf.pending()).toBe(1)
    act(() => raf.flush())
    expect(renderers[0].renders).toBe(1)
    // Só o motor assina o feed (a energia da barra vem dele); a camada dos balões dentro do palco.
    expect(src.subs).toBe(1)
    expect(screen.getByTestId('office3d-stage').querySelectorAll('.qb-layer')).toHaveLength(1)
    const stage = screen.getByTestId('office3d-stage')
    first.unmount()
    expect(renderers[0].disposed).toBe(true)
    expect(src.subs).toBe(0)
    // Os observers (o do palco, no motor, e o do topo do chat flutuante) todos desligados.
    expect(observed).toHaveLength(2)
    expect(disconnects).toHaveLength(observed.length)
    expect(stage.querySelector('.qb-layer')).toBeNull()
    expect(document.querySelector('.qb-layer')).toBeNull()
    // Cada listener de window adicionado pelo motor saiu.
    const engineTypes = new Set(['pointermove', 'pointerup', 'keydown', 'keyup', 'blur'])
    const ours = add.mock.calls.filter(([t]) => engineTypes.has(t as string))
    // + o keydown do Esc do papel pego (quadro, na captura) e o do atalho de DEV (feed de demonstração), também removidos.
    expect(ours.length).toBe(engineTypes.size + 1 + (import.meta.env.DEV ? 1 : 0))
    for (const [type, fn] of ours) expect(remove.mock.calls.some(([t, f]) => t === type && f === fn)).toBe(true)

    render(<Office3DWorkspace {...props} />)
    expect(renderers).toHaveLength(2)
    act(() => raf.flush())
    expect(renderers[1].renders).toBeGreaterThan(0)
    expect(document.querySelectorAll('.qb-layer')).toHaveLength(1)
  })

  it('Ctrl+Alt+Shift+P abre e fecha o HUD de desempenho com os números do renderer (DEV)', () => {
    if (!import.meta.env.DEV) return
    const r = { ...fakeRenderer(), info: { render: { calls: 321, triangles: 45_678 } } }
    const raf = manualRaf()
    render(
      <Office3DWorkspace
        chat={null}
        onOpenConversation={vi.fn()}
        onOpenFile={vi.fn()}
        engineOptions={{ ...raf.opts, source: source(syntheticFeed()), createRenderer: () => r }}
      />
    )
    act(() => raf.flush())
    expect(screen.queryByTestId('o3d-perf')).toBeNull()
    const press = (): void => {
      act(() => void fireEvent.keyDown(window, { key: 'P', ctrlKey: true, altKey: true, shiftKey: true }))
    }
    press()
    const hud = screen.getByTestId('o3d-perf')
    expect(hud.textContent).toContain('321 draw calls')
    expect(hud.textContent).toContain('45.7k triângulos')
    expect(hud.textContent).toMatch(/zonas \d+\/\d+ · LOD (perto|médio|longe) · pixelRatio \d\.\d\d/)
    expect(hud.textContent).toContain('fps')
    press()
    expect(screen.queryByTestId('o3d-perf')).toBeNull()
  })

  it('desmontar com quadro pendente cancela o RAF', () => {
    const raf = manualRaf()
    const view = render(
      <Office3DWorkspace
        chat={null}
        onOpenConversation={vi.fn()}
        onOpenFile={vi.fn()}
        engineOptions={{ ...raf.opts, source: source(null), createRenderer: fakeRenderer }}
      />
    )
    expect(raf.pending()).toBe(1)
    view.unmount()
    expect(raf.cancelled).toHaveLength(1)
    expect(raf.pending()).toBe(0)
  })

  it('cena parada não fica renderizando; WASD acorda o laço e o soltar deixa parar', () => {
    const r = fakeRenderer()
    const raf = manualRaf()
    render(
      <Office3DWorkspace
        chat={null}
        onOpenConversation={vi.fn()}
        onOpenFile={vi.fn()}
        engineOptions={{ ...raf.opts, source: source(null), createRenderer: () => r }}
      />
    )
    act(() => raf.flush(3))
    expect(r.renders).toBe(1)
    expect(raf.pending()).toBe(0)
    fireEvent.keyDown(window, { key: 'w' })
    act(() => raf.flush(3))
    expect(r.renders).toBe(4)
    fireEvent.keyUp(window, { key: 'w' })
    act(() => raf.flush(3))
    expect(raf.pending()).toBe(0)
    // Tecla dentro de um campo de texto não move.
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    fireEvent.keyDown(ta, { key: 'w' })
    expect(raf.pending()).toBe(0)
    ta.remove()
  })

  it('clique no agente voa até o monitor e abre a tela; Esc volta; duplo clique abre a conversa', () => {
    const feed = syntheticFeed()
    const target = layoutOffice(deriveOfficeModel(feed, Date.now())).characters.find((c) => c.deskIndex !== null && c.model.active)!
    const pick = vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(target.key)
    const raf = manualRaf()
    const onOpen = vi.fn()
    render(
      <Office3DWorkspace
        chat={null}
        onOpenConversation={onOpen}
        onOpenFile={vi.fn()}
        engineOptions={{ ...raf.opts, source: source(feed), createRenderer: fakeRenderer }}
      />
    )
    const canvas = screen.getByTestId('office3d-canvas')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 51, clientY: 50 })
    expect(screen.getByTestId('office-screen')).toBeTruthy()
    // Tween de ~400 ms; a âncora acompanha o monitor projetado.
    act(() => raf.flush(30))
    const anchor = screen.getByTestId('office-screen').parentElement as HTMLElement
    expect(anchor.className).toContain('o3d-screen-anchor')
    expect(anchor.style.width).toMatch(/px$/)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('office-screen')).toBeNull()

    fireEvent.doubleClick(canvas, { clientX: 50, clientY: 50 })
    expect(onOpen).toHaveBeenCalledWith(target.model.convId)

    // Clique no vazio com a tela aberta fecha a tela.
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 50, clientY: 50 })
    expect(screen.getByTestId('office-screen')).toBeTruthy()
    pick.mockReturnValue(null)
    fireEvent.pointerDown(canvas, { button: 0, clientX: 5, clientY: 5 })
    fireEvent.pointerUp(window, { button: 0, clientX: 5, clientY: 5 })
    expect(screen.queryByTestId('office-screen')).toBeNull()
  })

  it('Ctrl+Alt+Shift+D liga o tique da demo; desligar e desmontar limpam intervalo e override (DEV)', () => {
    if (!import.meta.env.DEV) return
    const start = 14_916_667 * DEMO_LOOP_MS
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: start })
    try {
      const press = (): void => {
        act(() => void fireEvent.keyDown(window, { key: 'D', ctrlKey: true, altKey: true, shiftKey: true }))
      }
      const view = render(
        <Office3DWorkspace chat={null} onOpenConversation={vi.fn()} onOpenFile={vi.fn()} engineOptions={{ ...manualRaf().opts, source: source(null), createRenderer: fakeRenderer }} />
      )
      // O motor já tem o tique dele (falas e energia); a demo soma exatamente um.
      const base = vi.getTimerCount()
      press()
      expect(officeStore.overridden).toBe(true)
      expect(vi.getTimerCount()).toBe(base + 1)
      const first = officeStore.getSnapshot()
      // Cada tique republica demoFeed(Date.now()): um quadro novo, no relógio do tique.
      act(() => void vi.advanceTimersByTime(DEMO_TICK_MS))
      const second = officeStore.getSnapshot()
      expect(second).not.toBe(first)
      expect(second?.usageLimits?.five_hour?.updatedAt).toBe(start + DEMO_TICK_MS)
      act(() => void vi.advanceTimersByTime(3 * DEMO_TICK_MS))
      expect(officeStore.getSnapshot()?.usageLimits?.five_hour?.updatedAt).toBe(start + 4 * DEMO_TICK_MS)
      // Desligar: some o override e o intervalo.
      press()
      expect(officeStore.overridden).toBe(false)
      expect(vi.getTimerCount()).toBe(base)
      // Ligada de novo, o unmount também limpa tudo.
      press()
      expect(vi.getTimerCount()).toBe(base + 1)
      view.unmount()
      expect(officeStore.overridden).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      officeStore.setOverride(null)
    }
  })

  it('tela cheia sem "Sair do 3D" (as abas fazem isso); o chat da conversa flutua por cima', () => {
    render(<Office3DWorkspace chat={<div>chat</div>} onOpenConversation={vi.fn()} onOpenFile={vi.fn()} engineOptions={{ ...manualRaf().opts, source: source(null), createRenderer: fakeRenderer }} />)
    expect(screen.queryByRole('button', { name: /Sair do 3D/ })).toBeNull()
    expect(screen.getByText('chat').closest('.pl-chat-float')).toBe(screen.getByRole('region', { name: 'Escritório' }))
  })

  it('aba fechada: a tela do monitor some (sem assinar feed nem código ao vivo); de volta, mostra o conteúdo de agora', () => {
    const feed = syntheticFeed()
    const target = layoutOffice(deriveOfficeModel(feed, Date.now())).characters.find((c) => c.deskIndex !== null && c.model.active && !c.model.trackId)!
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(target.key)
    const src = source(feed)
    const raf = manualRaf()
    // O cartão de ferramenta da tela é o ToolCard do chat (usa o UiProvider, como no app).
    const ui = (active: boolean): JSX.Element => (
      <UiProvider>
        <Office3DWorkspace active={active} chat={null} onOpenConversation={vi.fn()} onOpenFile={vi.fn()} engineOptions={{ ...raf.opts, source: src, createRenderer: fakeRenderer }} />
      </UiProvider>
    )
    const view = render(ui(true))
    fireEvent.pointerDown(screen.getByTestId('office3d-canvas'), { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 50, clientY: 50 })
    // Abre no Chat (o turno, vazio aqui); o Código fica a um clique.
    expect([screen.getByTestId('office-screen').dataset.mode, screen.getByTestId('office-screen').dataset.kind]).toEqual(['chat', 'empty'])
    fireEvent.click(screen.getByRole('button', { name: 'Código' }))
    expect(screen.getByTestId('office-screen').dataset.kind).toBe('empty')
    expect(src.subs).toBe(2) // o motor + a tela acompanhando o feed
    // O App re-renderiza (mesmas props): a âncora da tela não é religada no motor.
    const setScreen = vi.spyOn(Office3DEngine.prototype, 'setScreenElement')
    view.rerender(ui(true))
    expect(setScreen).not.toHaveBeenCalled()
    const convId = target.model.convId
    const delta: ToolInputDelta = { kind: 'tool-input-delta', toolUseId: 'w1', name: 'Write', filePath: 'C:\\a.ts', newText: 'x', totalLines: 1, done: false }
    act(() => liveInput.push(convId, delta))
    expect(liveInput.latest(convId, null)).toBeTruthy() // a tela assina o código ao vivo do principal
    // …e abre o arquivo que ele digita (linha atual: o código e a etiqueta do cursor); fechado o bloco, para de digitar.
    const shown = screen.getByTestId('office-screen')
    const current = screen.getByRole('tabpanel').querySelector('.cm-current .cm-code')
    expect([shown.dataset.kind, screen.getByRole('tab', { name: 'a.ts, digitando' }).getAttribute('aria-selected'), current?.textContent, shown.querySelector('.cm-statusbar')?.textContent?.includes('digitando a.ts…')]).toEqual(['code', 'true', 'xAgent', true])
    act(() => liveInput.push(convId, { ...delta, done: true }))
    expect([screen.queryByRole('tab', { name: 'a.ts, digitando' }), !!screen.queryByRole('tab', { name: 'a.ts' }), shown.querySelector('.cm-caret')]).toEqual([null, true, null])

    view.rerender(ui(false))
    expect(screen.queryByTestId('office-screen')).toBeNull()
    expect(src.subs).toBe(1) // só o motor (pausado), que guarda o feed para a volta
    act(() => liveInput.push(convId, delta))
    expect(liveInput.latest(convId, null)).toBeUndefined() // sem assinante: descartado
    // Com a aba fechada a conversa passa a rodar outra ferramenta.
    const later = {
      ...feed,
      conversations: feed.conversations.map((c) =>
        c.id === convId ? { ...c, messages: [{ kind: 'tool-use' as const, id: 'b1', name: 'Bash', input: { command: 'npm run build' }, parentToolUseId: null }] } : c
      )
    }
    act(() => src.emit(later))

    view.rerender(ui(true))
    const screenEl = screen.getByTestId('office-screen')
    // De volta, a tela renasce no último app usado (o Código): o que ele faz agora, o comando no
    // terminal (nada do código ao vivo de antes); no Chat, o ToolCard dele.
    const term = screen.getByRole('region', { name: 'Terminal' })
    expect([screenEl.dataset.kind, term.querySelector('.cm-cmdline')?.textContent, term.querySelector('.cm-run.run')?.textContent, screen.queryByRole('tab')]).toEqual(['code', 'npm run build', 'executando', null])
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(screenEl.dataset.kind).toBe('chat')
    expect(screenEl.querySelector('.tool-card .tool-name')?.textContent).toBe('Bash')
    expect(screenEl.querySelector('.tool-card .tool-detail')?.textContent).toBe('npm run build')
    expect(src.subs).toBe(2)
  })

  it('aba fechada para a demo e o HUD de desempenho (DEV): intervalos e override limpos, atalhos mudos', () => {
    if (!import.meta.env.DEV) return
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: 14_916_667 * DEMO_LOOP_MS })
    try {
      const press = (key: string): void => {
        act(() => void fireEvent.keyDown(window, { key, ctrlKey: true, altKey: true, shiftKey: true }))
      }
      const ui = (active: boolean): JSX.Element => (
        <Office3DWorkspace active={active} chat={null} onOpenConversation={vi.fn()} onOpenFile={vi.fn()} engineOptions={{ ...manualRaf().opts, source: source(null), createRenderer: fakeRenderer }} />
      )
      const view = render(ui(true))
      const base = vi.getTimerCount() // o tique do motor
      press('D')
      press('P')
      expect(officeStore.overridden).toBe(true)
      expect(screen.getByTestId('o3d-perf')).toBeTruthy()
      expect(vi.getTimerCount()).toBe(base + 2) // a demo + o HUD de desempenho
      view.rerender(ui(false))
      expect(officeStore.overridden).toBe(false)
      expect(screen.queryByTestId('o3d-perf')).toBeNull()
      expect(vi.getTimerCount()).toBe(base - 1) // nem o tique do motor (pausado)
      press('D')
      expect(officeStore.overridden).toBe(false)
      expect(vi.getTimerCount()).toBe(base - 1)
      view.unmount()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      officeStore.setOverride(null)
    }
  })

  it('balão de pedido ("Clica em mim") leva ao pedido da conversa (onFocusRequest); os outros balões focam o agente', () => {
    const raf = manualRaf()
    const onFocusRequest = vi.fn()
    const props = { chat: null, onOpenConversation: vi.fn(), onOpenFile: vi.fn(), engineOptions: { ...raf.opts, source: source(syntheticFeed()), createRenderer: fakeRenderer } }
    const view = render(<Office3DWorkspace {...props} onFocusRequest={onFocusRequest} />)
    act(() => raf.flush())
    const bubble = (key: string): HTMLElement => screen.getByTestId('office3d-stage').querySelector<HTMLElement>(`.qb[data-key="${key}"]`)!
    expect(bubble('conv:dev-0-3').dataset.kind).toBe('permission')
    act(() => bubble('conv:dev-0-3').click())
    expect(onFocusRequest).toHaveBeenCalledWith('dev-0-3')
    expect(screen.queryByTestId('office-screen')).toBeNull()
    // Balão comum (progresso): foca o agente, como sempre.
    expect(bubble('conv:dev-0-0').dataset.kind).toBe('progress')
    act(() => bubble('conv:dev-0-0').click())
    expect(onFocusRequest).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('office-screen')).toBeTruthy()
    view.unmount()

    // Sem quem responda o pedido, o balão de permissão também só foca o agente.
    render(<Office3DWorkspace {...props} />)
    act(() => raf.flush())
    act(() => bubble('conv:dev-0-3').click())
    expect(screen.getByTestId('office-screen')).toBeTruthy()
  })

  it('chat flutuante na troca de aba: com um agente focado, seleciona a conversa dele; sem mesa, a Central; sem `central`, sempre o chat', () => {
    const feed = syntheticFeed()
    const target = layoutOffice(deriveOfficeModel(feed, Date.now())).characters.find((c) => c.model.convId === 'dev-2-1')!
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(target.key)
    const onOpen = vi.fn()
    const opts = { ...manualRaf().opts, source: source(feed), createRenderer: fakeRenderer }
    const ui = (active: boolean, id = 'dev-1-0', central: JSX.Element | null = <div>central</div>): JSX.Element => (
      <Office3DWorkspace active={active} chat={active ? <div>chat</div> : null} central={active ? central : null} conversation={{ id, title: id, cwd: 'C:\\p' }} onOpenConversation={onOpen} engineOptions={opts} />
    )
    const shows = (): string | null | undefined => screen.getByRole('region', { name: 'Escritório' }).querySelector('.pl-chat-float-body')?.textContent
    const click = (): void => {
      fireEvent.pointerDown(screen.getByTestId('office3d-canvas'), { button: 0, clientX: 50, clientY: 50 })
      fireEvent.pointerUp(window, { button: 0, clientX: 50, clientY: 50 })
    }
    const view = render(ui(true, 'dev-0-0'))
    expect(shows()).toBe('central') // aberta sem mesa selecionada
    click()
    onOpen.mockClear()
    view.rerender(ui(false)) // na aba Conversa, outra conversa é escolhida
    view.rerender(ui(true))
    expect(onOpen).toHaveBeenCalledWith('dev-2-1')
    expect(shows()).toBe('chat')
    // Sem mesa (a conversa veio de fora): reabrir mostra a Central, sem selecionar nada.
    fireEvent.keyDown(window, { key: 'Escape' })
    view.rerender(ui(true, 'dev-3-0'))
    expect(shows()).toBe('chat')
    view.rerender(ui(false, 'dev-3-0'))
    view.rerender(ui(true, 'dev-3-0'))
    expect(shows()).toBe('central')
    expect(onOpen).toHaveBeenCalledTimes(1)
    view.rerender(ui(true, 'dev-3-0', null))
    click()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(shows()).toBe('chat')
  })
})

describe('OfficeScene', () => {
  function meshes(scene: Scene): Mesh[] {
    const out: Mesh[] = []
    scene.traverse((o) => {
      if (o instanceof Mesh) out.push(o)
    })
    return out
  }

  it('acende o monitor do agente ativo, mostra o indicador de permissão e libera tudo no dispose', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const feed = syntheticFeed()
    const layout = layoutOffice(deriveOfficeModel(feed, Date.now()))
    const s = new OfficeScene()
    s.sync(layout)
    const lit = meshes(s.scene).filter((m) => m.userData.screen === 'on')
    const activeOwners = layout.characters.filter((c) => c.deskIndex !== null && c.model.active).length
    expect(activeOwners).toBeGreaterThan(0)
    expect(lit).toHaveLength(activeOwners)
    const perm = layout.characters.filter((c) => c.model.bubble === 'permissao')
    expect(perm.length).toBeGreaterThan(0)
    expect(s.animate(1)).toBe(true)

    const geoms = new Set(meshes(s.scene).map((m) => m.geometry))
    const disposed = new Set<unknown>()
    for (const g of geoms) g.addEventListener('dispose', () => disposed.add(g))
    s.dispose()
    expect(disposed.size).toBe(geoms.size)
    expect(s.scene.children).toHaveLength(0)
  })

  it('sync sem os agentes remove personagens e apaga os monitores', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const feed = syntheticFeed()
    const full = layoutOffice(deriveOfficeModel(feed, Date.now()))
    const s = new OfficeScene()
    s.sync(full)
    const empty = layoutOffice({ rooms: deriveOfficeModel(feed, Date.now()).rooms, characters: [] }, full)
    s.sync(empty)
    expect(s.character(full.characters[0].key)).toBeUndefined()
    expect(meshes(s.scene).some((m) => m.userData.screen === 'on')).toBe(false)
    expect(meshes(s.scene).some((m) => m.userData.screen === 'saver')).toBe(false)
    expect(s.animate(1)).toBe(false)
    s.dispose()
  })
})
