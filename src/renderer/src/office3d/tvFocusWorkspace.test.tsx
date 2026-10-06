import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeliveryCenterContext, type DeliveryCenterValue } from '../deliveries/deliveryCenterContext'
import { envio } from '../handoffTracking/handoffFixtures'
import { principalKey, roomIdFor } from '../office/adapter/model'
import { conv, feed } from '../office/adapter/testFeed'
import { UiProvider } from '../ui/UiProvider'
import type { UIMessage } from '../types'
import { MONITOR_FILL } from './cameraRig'
import { Office3DEngine, type FeedSource, type RendererLike } from './engine'
import { FILTER_KEY } from './engineFilter'
import { MEMORY_SHELF_KEY, PROJECTOR_KEY } from './engineTypes'
import { OFFICE_ID } from './layout'
import { callMarks } from './officeCalls'
import { Office3DWorkspace } from './Office3DWorkspace'
import { OfficeScene } from './scene'
import { BUBBLE_TOP } from './speech'

const NOW = Date.now()
const CALL_ID = `call-tv-${NOW}`
const MSGS: UIMessage[] = [
  { kind: 'user', id: 'u1', text: 'faz a tela de login' },
  { kind: 'tool-use', id: CALL_ID, name: 'mcp__app__app_chamar_usuario', input: { arquivo: 'tela.html', mensagem: 'Pronta!' }, parentToolUseId: null, result: { isError: false, text: 'ok' } }
]

/** Um agente chamando (app_chamar_usuario com tela.html), com o id do chamado. */
const callMsgs = (id: string): UIMessage[] => [MSGS[0], { ...MSGS[1], id } as UIMessage]

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
  // O filtro do HUD (o callSignal o põe num projeto) fica no localStorage: o próximo teste começa sem ele.
  localStorage.removeItem(FILTER_KEY)
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

  it('agente chamando + plano no escritório: o clique na TV abre o PLANO (o chamado não conta como visto), com a aba "Agente chamando (1)"; ela abre o mockup (agora visto) e Aprovar manda para o agente', async () => {
    const callId = `call-tv-plano-${NOW}`
    const f = feed({ conversations: [conv('a', { messages: callMsgs(callId), updatedAt: NOW }), conv('p', { mode: 'planning', planningSlug: 'checkout', title: 'Plano', updatedAt: NOW })], activeId: 'p' })
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(`${PROJECTOR_KEY}${OFFICE_ID}`)
    const raf = manualRaf()
    const send = vi.fn()
    render(
      <Office3DWorkspace
        chat={null}
        onOpenConversation={vi.fn()}
        onSendToConversation={send}
        conversation={{ id: 'p', title: 'Plano', cwd: 'C:\\proj\\alpha' } as never}
        planning={<div data-testid="planning-ws">plano</div>}
        engineOptions={{ ...raf.opts, source: source(f), createRenderer: renderer, browser: null }}
      />
    )
    const canvas = screen.getByTestId('office3d-canvas')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 51, clientY: 50 })
    expect(screen.getByTestId('tv-focus').dataset.kind).toBe('plan')
    expect(screen.getByTestId('planning-ws')).toBeTruthy()
    expect(callMarks.ended(callId)).toBe(false)
    act(() => raf.flush(40))
    fireEvent.click(screen.getByRole('tab', { name: 'Agente chamando (1)' }))
    expect(screen.getByTestId('tv-focus').dataset.kind).toBe('mockup')
    expect(callMarks.ended(callId)).toBe(true)
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Aprovar' }))
    expect(send).toHaveBeenCalledWith('a', 'Aprovado: tela.html')
    expect(screen.queryByTestId('tv-focus')).toBeNull()
  })

  it('agente chamando + "📋 Planejar": a TV abre no plano novo, não no mockup de quem chama', async () => {
    const callId = `call-tv-planejar-${NOW}`
    const f = feed({ conversations: [conv('a', { messages: callMsgs(callId), updatedAt: NOW }), conv('p', { mode: 'planning', planningSlug: 's', updatedAt: NOW - 5000 })], activeId: 'a' })
    const raf = manualRaf()
    const start = vi.fn(async () => 'p')
    render(<Office3DWorkspace chat={null} onOpenConversation={vi.fn()} onStartPlanning={start} planProjects={[{ cwd: 'C:\\proj\\alpha', name: 'alpha' }]} engineOptions={{ ...raf.opts, source: source(f), createRenderer: renderer, browser: null }} />)
    fireEvent.click(screen.getByRole('button', { name: /Planejar/ }))
    fireEvent.change(screen.getByLabelText('Pedido inicial'), { target: { value: 'checkout com Pix' } })
    fireEvent.click(screen.getByRole('button', { name: 'Planejar na TV' }))
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    expect(start).toHaveBeenCalledWith('C:\\proj\\alpha', 'checkout com Pix')
    const tv = screen.getByTestId('tv-focus')
    expect(tv.dataset.kind).toBe('plan')
    expect(screen.getByRole('tab', { name: 'Agente chamando (1)' })).toBeTruthy()
    expect(callMarks.ended(callId)).toBe(false)
  })

  it('"📋 Planejar" com o filtro do HUD em outro projeto: a TV abre no plano criado, mesmo fora do filtro (ele entra nas abas)', async () => {
    const alpha = 'C:\\proj\\alpha'
    const beta = 'C:\\proj\\beta'
    const callId = `call-tv-filtro-${NOW}`
    const f = feed({ conversations: [conv('a', { messages: callMsgs(callId), updatedAt: NOW }), conv('p', { mode: 'planning', planningSlug: 's', title: 'Plano beta', cwd: beta, updatedAt: NOW - 5000 })], activeId: 'a' })
    const raf = manualRaf()
    const start = vi.fn(async () => 'p')
    const props = { chat: null, onOpenConversation: vi.fn(), onStartPlanning: start, planProjects: [{ cwd: alpha, name: 'alpha' }, { cwd: beta, name: 'beta' }], engineOptions: { ...raf.opts, source: source(f), createRenderer: renderer, browser: null } }
    const v = render(<Office3DWorkspace {...props} callSignal={{ n: 0, projectId: null }} />)
    // O filtro do HUD no alpha (o clique na notificação do chamado o põe lá).
    v.rerender(<Office3DWorkspace {...props} callSignal={{ n: 1, projectId: roomIdFor(alpha) }} />)
    fireEvent.click(screen.getByRole('button', { name: /Planejar/ }))
    fireEvent.change(screen.getByLabelText('Projeto'), { target: { value: beta } })
    fireEvent.change(screen.getByLabelText('Pedido inicial'), { target: { value: 'login novo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Planejar na TV' }))
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    expect(start).toHaveBeenCalledWith(beta, 'login novo')
    expect(screen.getByTestId('tv-focus').dataset.kind).toBe('plan')
    expect(screen.getByRole('tab', { name: 'Plano beta' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Agente chamando (1)' })).toBeTruthy()
  })

  it('aba Implantação do plano: "Ir até o agente" voa até a mesa do agente da implementação (flyToAgent com a chave dele); fora do escritório, avisa, fecha a TV e abre a conversa', async () => {
    const f = feed({ conversations: [conv('p', { mode: 'planning', planningSlug: 'checkout', title: 'Plano', updatedAt: NOW })], activeId: 'p' })
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(`${PROJECTOR_KEY}${OFFICE_ID}`)
    const fly = vi.spyOn(Office3DEngine.prototype, 'flyToAgent')
    const raf = manualRaf()
    const center: DeliveryCenterValue = {
      envios: [envio({ planSlug: 'checkout', projectCwd: 'C:\\proj\\alpha', conversationId: 'impl', conversationTitle: 'Implementação: checkout' })],
      error: null,
      correct: vi.fn(),
      openConversation: vi.fn()
    }
    render(
      <UiProvider>
        <DeliveryCenterContext.Provider value={center}>
          <Office3DWorkspace
            chat={null}
            onOpenConversation={vi.fn()}
            conversation={{ id: 'p', title: 'Plano', cwd: 'C:\\proj\\alpha' } as never}
            planning={<div data-testid="planning-ws">plano</div>}
            engineOptions={{ ...raf.opts, source: source(f), createRenderer: renderer, browser: null }}
          />
        </DeliveryCenterContext.Provider>
      </UiProvider>
    )
    const canvas = screen.getByTestId('office3d-canvas')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 51, clientY: 50 })
    expect(screen.getByTestId('tv-focus').dataset.kind).toBe('plan')
    fireEvent.click(screen.getByRole('tab', { name: 'Implantação · 0/1 · em execução' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ir até o agente' }))
    expect(fly).toHaveBeenCalledWith(principalKey('impl'), 'desk')
    expect(fly).toHaveLastReturnedWith(false)
    expect(center.openConversation).toHaveBeenCalledWith('impl')
    expect(screen.queryByTestId('tv-focus')).toBeNull()
    expect(await screen.findByText(/não está no escritório agora/)).toBeTruthy()
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

  it('clique no Agent Manager: o foco vai para a TV no plano dele, a conversa do plano vira a ativa e a Tela de Planejamento aparece dentro da TV', () => {
    const f = feed({ conversations: [conv('a'), conv('p', { mode: 'planning', planningSlug: 'checkout', title: 'Plano', updatedAt: NOW })], activeId: 'a' })
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue('conv:p')
    const raf = manualRaf()
    const open = vi.fn()
    const props = { chat: null, onOpenConversation: open, engineOptions: { ...raf.opts, source: source(f), createRenderer: renderer, browser: null } }
    const v = render(<Office3DWorkspace {...props} conversation={{ id: 'a', title: 'a', cwd: 'C:\\proj\\alpha' } as never} planning={<div data-testid="planning-ws">plano</div>} />)
    const canvas = screen.getByTestId('office3d-canvas')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 51, clientY: 50 })
    expect(screen.getByTestId('tv-focus').dataset.kind).toBe('plan')
    expect(open).toHaveBeenCalledWith('p')
    expect(screen.queryByTestId('planning-ws')).toBeNull()
    // O App troca a conversa ativa para a do plano: a tela entra na TV.
    v.rerender(<Office3DWorkspace {...props} conversation={{ id: 'p', title: 'Plano', cwd: 'C:\\proj\\alpha' } as never} planning={<div data-testid="planning-ws">plano</div>} />)
    expect(screen.getByTestId('planning-ws')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('tv-focus')).toBeNull()
  })

  it('a TV com o plano, parada: a tela fica plana (sem transform), do tamanho da TV projetada — quase toda a largura do palco, abaixo da faixa do HUD — com a Tela de Planejamento dentro', () => {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1400)
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(800)
    const f = feed({ conversations: [conv('p', { mode: 'planning', planningSlug: 'checkout', title: 'Plano', updatedAt: NOW })], activeId: 'p' })
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(`${PROJECTOR_KEY}${OFFICE_ID}`)
    const raf = manualRaf()
    render(
      <Office3DWorkspace
        chat={null}
        onOpenConversation={vi.fn()}
        conversation={{ id: 'p', title: 'Plano', cwd: 'C:\\proj\\alpha' } as never}
        planning={<div data-testid="planning-ws">plano</div>}
        engineOptions={{ ...raf.opts, source: source(f), createRenderer: renderer, browser: null }}
      />
    )
    const canvas = screen.getByTestId('office3d-canvas')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 51, clientY: 50 })
    expect(screen.getByTestId('tv-focus').dataset.kind).toBe('plan')
    const anchor = screen.getByTestId('tv-focus').parentElement as HTMLElement
    expect(anchor.querySelector('.tvf-plan [data-testid="planning-ws"]')).toBeTruthy()
    act(() => raf.flush(40))
    expect([anchor.style.transform, anchor.style.pointerEvents]).toEqual(['', ''])
    const [left, top, width, height] = (['left', 'top', 'width', 'height'] as const).map((k) => parseFloat(anchor.style[k]))
    // A TV (2,23 × 1,12 m) é mais larga que o palco: a largura limita — MONITOR_FILL dele, centrada.
    expect(width).toBe(Math.round(MONITOR_FILL * 1400))
    expect(Math.abs(left - (1400 - width) / 2)).toBeLessThanOrEqual(1)
    expect(top).toBeGreaterThanOrEqual(BUBBLE_TOP - 1)
    expect(top + height).toBeLessThanOrEqual(800)
  })

  it('trocar de plano pelas abas, bem depois do clique: a conversa ativa vira a do outro plano e a câmera fica na TV', () => {
    const f = feed({ conversations: [conv('p', { mode: 'planning', planningSlug: 'checkout', title: 'Checkout', updatedAt: NOW }), conv('q', { mode: 'planning', planningSlug: 'login', title: 'Login', updatedAt: NOW - 1000 })], activeId: 'p' })
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(`${PROJECTOR_KEY}${OFFICE_ID}`)
    const follow = vi.spyOn(Office3DEngine.prototype, 'follow')
    const raf = manualRaf()
    const open = vi.fn()
    const props = { chat: null, onOpenConversation: open, planning: <div data-testid="planning-ws">plano</div>, engineOptions: { ...raf.opts, source: source(f), createRenderer: renderer, browser: null } }
    const v = render(<Office3DWorkspace {...props} conversation={{ id: 'p', title: 'Checkout', cwd: 'C:\\proj\\alpha' } as never} />)
    const canvas = screen.getByTestId('office3d-canvas')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 51, clientY: 50 })
    expect(screen.getByTestId('tv-focus').dataset.kind).toBe('plan')
    // Passada a janela de graça do clique (o follow voaria até o Manager e fecharia a TV).
    act(() => raf.flush(200))
    fireEvent.click(screen.getByRole('tab', { name: 'Login' }))
    expect(open).toHaveBeenCalledWith('q')
    v.rerender(<Office3DWorkspace {...props} conversation={{ id: 'q', title: 'Login', cwd: 'C:\\proj\\alpha' } as never} />)
    expect(screen.getByTestId('tv-focus').dataset.kind).toBe('plan')
    expect(screen.getByRole('tab', { name: 'Login' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('planning-ws')).toBeTruthy()
    expect(follow).not.toHaveBeenCalled()
  })

  it('conversa de planejamento escolhida fora do 3D: a câmera vai à TV com o plano na tela (não voa até o agente); conversa normal segue o agente', () => {
    const f = feed({ conversations: [conv('a'), conv('p', { mode: 'planning', planningSlug: 'checkout', title: 'Checkout', updatedAt: NOW })], activeId: 'a' })
    const follow = vi.spyOn(Office3DEngine.prototype, 'follow')
    const raf = manualRaf()
    const props = { chat: null, onOpenConversation: vi.fn(), planning: <div data-testid="planning-ws">plano</div>, engineOptions: { ...raf.opts, source: source(f), createRenderer: renderer, browser: null } }
    const v = render(<Office3DWorkspace {...props} conversation={{ id: 'a', title: 'a', cwd: 'C:\\proj\\alpha' }} />)
    act(() => raf.flush(5))
    v.rerender(<Office3DWorkspace {...props} conversation={{ id: 'p', title: 'Checkout', cwd: 'C:\\proj\\alpha', mode: 'planning' }} />)
    expect(screen.getByTestId('tv-focus').dataset.kind).toBe('plan')
    expect(screen.getByTestId('planning-ws')).toBeTruthy()
    expect(follow).not.toHaveBeenCalled()
    v.rerender(<Office3DWorkspace {...props} conversation={{ id: 'a', title: 'a', cwd: 'C:\\proj\\alpha' }} />)
    expect(follow).toHaveBeenCalledWith('a')
  })

  it('"📋 Planejar": a TV vazia e o botão do HUD abrem o formulário (projeto do filtro); o plano criado abre na TV', async () => {
    const empty = feed({ conversations: [conv('a', { updatedAt: NOW })], activeId: 'a' })
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(`${PROJECTOR_KEY}${OFFICE_ID}`)
    const raf = manualRaf()
    const start = vi.fn(async () => 'p')
    const projects = [{ cwd: 'C:\\proj\\alpha', name: 'alpha' }]
    const v = render(<Office3DWorkspace chat={null} onOpenConversation={vi.fn()} onStartPlanning={start} planProjects={projects} engineOptions={{ ...raf.opts, source: source(empty), createRenderer: renderer, browser: null }} />)
    const canvas = screen.getByTestId('office3d-canvas')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 51, clientY: 50 })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('dialog', { name: '📋 Planejar' })).toBeTruthy()
    expect(screen.queryByTestId('tv-focus')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    v.unmount()
    // Com o plano já no escritório (o feed que o App publicaria depois de criar): o botão do HUD, criar e a TV abre nele.
    const withPlan = feed({ conversations: [conv('a', { updatedAt: NOW }), conv('p', { mode: 'planning', planningSlug: 's', updatedAt: NOW - 5000 })], activeId: 'a' })
    render(<Office3DWorkspace chat={null} onOpenConversation={vi.fn()} onStartPlanning={start} planProjects={projects} engineOptions={{ ...raf.opts, source: source(withPlan), createRenderer: renderer, browser: null }} />)
    fireEvent.click(screen.getByRole('button', { name: /Planejar/ }))
    fireEvent.change(screen.getByLabelText('Pedido inicial'), { target: { value: 'checkout com Pix' } })
    fireEvent.click(screen.getByRole('button', { name: 'Planejar na TV' }))
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })
    expect(start).toHaveBeenCalledWith('C:\\proj\\alpha', 'checkout com Pix')
    expect(screen.getByTestId('tv-focus').dataset.kind).toBe('plan')
  })

  it('clique na Central: voa até o console e o chat dela vai na tela do console (sem trocar a conversa ativa); o flutuante sai', () => {
    const f = feed({ conversations: [conv('a', { updatedAt: NOW }), conv('central', { mode: 'central', cwd: '', updatedAt: NOW })], activeId: 'a' })
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue('conv:central')
    const raf = manualRaf()
    const open = vi.fn()
    const props = {
      chat: <div data-testid="chat-float">chat</div>,
      central: <div data-testid="central-panel">Central</div>,
      onOpenConversation: open,
      engineOptions: { ...raf.opts, source: source(f), createRenderer: renderer, browser: null }
    }
    const v = render(<Office3DWorkspace {...props} centralSignal={0} />)
    expect(screen.getByTestId('central-panel')).toBeTruthy() // no flutuante, sem mesa selecionada
    const canvas = screen.getByTestId('office3d-canvas')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 51, clientY: 50 })
    const screenEl = screen.getByTestId('office-console-screen')
    expect(screenEl.querySelector('[data-testid="central-panel"]')).toBeTruthy()
    expect(screen.getAllByTestId('central-panel')).toHaveLength(1)
    expect(screen.queryByTestId('chat-float')).toBeNull()
    expect(open).not.toHaveBeenCalled()
    act(() => raf.flush(40))
    expect(screenEl.style.width).toMatch(/px$/)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('office-console-screen')).toBeNull()
    // Abrir a Central pela barra lateral com ela no console: a câmera volta à vista inicial e o chat dela, ao flutuante.
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 51, clientY: 50 })
    expect(screen.getByTestId('office-console-screen')).toBeTruthy()
    const reset = vi.spyOn(Office3DEngine.prototype, 'resetView')
    v.rerender(<Office3DWorkspace {...props} centralSignal={1} />)
    expect(reset).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('office-console-screen')).toBeNull()
    expect(screen.getByTestId('central-panel')).toBeTruthy()
    reset.mockRestore()
  })

  it('clique na estante de Memórias: voo curto e o painel (só leitura) à direita; Esc fecha', async () => {
    const f = feed({ conversations: [conv('a', { updatedAt: NOW })], activeId: 'a' })
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(MEMORY_SHELF_KEY)
    vi.stubGlobal('api', { memoryListEntries: vi.fn(async () => [{ relPath: 'raiz.md', title: 'Convenções', hook: 'g', folder: '', scope: 'user', projectCwd: null, revision: 1, status: 'active', updatedAt: new Date(NOW).toISOString() }]), listMemoryConflicts: vi.fn(async () => []), getCacheInfo: vi.fn(async () => ({ memoriesDir: 'D:\\m' })), listContextTurns: vi.fn(async () => []) })
    const raf = manualRaf()
    const open = vi.fn()
    render(<Office3DWorkspace chat={<div data-testid="chat-float">chat</div>} onOpenConversation={open} engineOptions={{ ...raf.opts, source: source(f), createRenderer: renderer, browser: null }} />)
    const canvas = screen.getByTestId('office3d-canvas')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 51, clientY: 50 })
    expect(screen.getByTestId('memory-panel')).toBeTruthy()
    expect(screen.queryByTestId('chat-float')).toBeNull()
    expect(open).not.toHaveBeenCalled()
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve()
    })
    expect(screen.getByText('Convenções')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('memory-panel')).toBeNull()
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
