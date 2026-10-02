import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RateLimitStatus } from '@shared/ipc'
import { conv, feed, track } from '../office/adapter/testFeed'
import { officeStore } from '../office/officeStore'
import type { EngineOptions, RendererLike } from '../office3d/engine'
import { LEVEL_COLORS, type PowerLevel } from '../office3d/power'
import { MainTabs, OfficeErrorBoundary, OfficeTabHost, officeTabTitle, useMainTab } from './MainTabs'
import { loadMainTab, officeTabStatus, type MainTab } from './mainTabState'

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

const fiveHour = (extra: Partial<RateLimitStatus>): Record<string, RateLimitStatus> => ({
  five_hour: { rateLimitType: 'five_hour', status: 'allowed', resetsAt: Date.now() + 3_600_000, ...extra } as RateLimitStatus
})

describe('MainTabs: o seletor da área principal', () => {
  it('tablist com Conversa e Escritório, aria-selected na ativa e troca pelo clique', () => {
    const onSelect = vi.fn()
    const { rerender } = render(<MainTabs active="chat" onSelect={onSelect} />)
    expect(screen.getByRole('tablist', { name: 'Área principal' })).toBeTruthy()
    const [chat, office] = screen.getAllByRole('tab')
    expect(chat.textContent).toContain('Conversa')
    expect(office.textContent).toContain('Escritório')
    expect(chat.getAttribute('aria-selected')).toBe('true')
    expect(chat.classList.contains('on')).toBe(true)
    expect(office.getAttribute('aria-selected')).toBe('false')
    fireEvent.click(office)
    expect(onSelect).toHaveBeenCalledWith('office')
    rerender(<MainTabs active="office" onSelect={onSelect} />)
    expect(screen.getByRole('tab', { name: /Escritório/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: /Conversa/ }).getAttribute('aria-selected')).toBe('false')
  })

  it('selo vivo: agentes trabalhando no escritório inteiro (conversas ocupadas + subagentes rodando)', () => {
    render(<MainTabs active="chat" onSelect={vi.fn()} />)
    expect(screen.queryByTestId('main-tab-working')).toBeNull()
    act(() =>
      officeStore.publish(
        feed({
          conversations: [conv('a'), conv('b'), conv('c')],
          busyIds: new Set(['a', 'c']),
          tracks: { a: { t1: track('t1'), t2: track('t2', { status: 'done' }) }, b: { t3: track('t3') } }
        })
      )
    )
    // a e c ocupadas + t1 (de a) e t3 (de b) rodando; t2 já terminou.
    expect(screen.getByTestId('main-tab-working').textContent).toBe('4')
    const office = screen.getByRole('tab', { name: /Escritório/ })
    expect(office.classList.contains('live')).toBe(true)
    expect(office.title).toContain('4 agentes trabalhando')
    act(() => officeStore.publish(feed({ conversations: [conv('a')] })))
    expect(screen.queryByTestId('main-tab-working')).toBeNull()
  })

  it('raio na cor do nível da energia (cheia, economia, alerta, apagão); sem a janela de 5h, sem raio', () => {
    render(<MainTabs active="chat" onSelect={vi.fn()} />)
    const level = (limits?: Record<string, RateLimitStatus>): string | null => {
      act(() => officeStore.publish({ ...feed({ conversations: [conv('a')] }), usageLimits: limits }))
      return screen.queryByTestId('main-tab-bolt')?.getAttribute('data-level') ?? null
    }
    expect(level(undefined)).toBeNull()
    expect(level(fiveHour({ utilization: 0.3 }))).toBe('cheia')
    expect(level(fiveHour({ utilization: 0.6 }))).toBe('economia')
    expect(level(fiveHour({ utilization: 0.9 }))).toBe('alerta')
    expect(level(fiveHour({ status: 'rejected', utilization: 1 }))).toBe('apagao')
    expect(screen.getByTestId('main-tab-bolt').classList.contains('lvl-apagao')).toBe(true)
  })

  it('a cor do raio vem de LEVEL_COLORS (variável CSS); o mainTabs.css não repete nenhuma delas em hex', () => {
    render(<MainTabs active="chat" onSelect={vi.fn()} />)
    const cases: Array<[PowerLevel, Partial<RateLimitStatus>]> = [
      ['cheia', { utilization: 0.3 }],
      ['economia', { utilization: 0.6 }],
      ['alerta', { utilization: 0.9 }],
      ['apagao', { status: 'rejected', utilization: 1 }]
    ]
    for (const [lvl, extra] of cases) {
      act(() => officeStore.publish({ ...feed({ conversations: [conv('a')] }), usageLimits: fiveHour(extra) }))
      const bolt = screen.getByTestId('main-tab-bolt')
      expect(bolt.getAttribute('data-level')).toBe(lvl)
      expect(bolt.style.getPropertyValue('--main-tab-bolt')).toBe(LEVEL_COLORS[lvl])
    }
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/mainTabs.css'), 'utf8').toLowerCase()
    for (const hex of Object.values(LEVEL_COLORS)) expect(css).not.toContain(hex.toLowerCase())
    expect(css).toMatch(/\.main-tab-bolt \{[^}]*var\(--main-tab-bolt/)
  })

  it('o nível do raio tem a mesma histerese da pílula: 51% depois de cair abaixo de 50% continua em economia', () => {
    render(<MainTabs active="chat" onSelect={vi.fn()} />)
    const at = (used: number): string | null => {
      act(() => officeStore.publish({ ...feed({ conversations: [conv('a')] }), usageLimits: fiveHour({ utilization: used }) }))
      return screen.getByTestId('main-tab-bolt').getAttribute('data-level')
    }
    expect(at(0.4)).toBe('cheia') // 60%
    expect(at(0.51)).toBe('economia') // 49%: caiu abaixo de 50
    expect(at(0.49)).toBe('economia') // 51%: dentro da folga (sem a leitura anterior, seria 'cheia')
    expect(officeTabStatus({ ...feed({ conversations: [conv('a')] }), usageLimits: fiveHour({ utilization: 0.49 }) }, Date.now()).level).toBe('cheia')
    expect(at(0.46)).toBe('cheia') // 54%: passou a folga (POWER_HYSTERESIS)
  })

  it('officeTabStatus e o título da aba', () => {
    expect(officeTabStatus(null, Date.now())).toEqual({ working: 0, level: null, pct: null, power: null })
    const s = officeTabStatus({ ...feed({ conversations: [conv('a')], busyIds: new Set(['a']) }), usageLimits: fiveHour({ utilization: 0.28 }) }, Date.now())
    expect(s).toMatchObject({ working: 1, level: 'cheia', pct: 72, power: { pct: 72, level: 'cheia' } })
    expect(officeTabTitle(1, 'cheia', 72)).toBe('Escritório 3D: todos os projetos numa tela só — 1 agente trabalhando · energia 72% (Energia cheia)')
    expect(officeTabTitle(0, null, null)).toBe('Escritório 3D: todos os projetos numa tela só — ninguém trabalhando agora')
  })
})

describe('useMainTab: a aba lembrada entre sessões', () => {
  function Harness(): JSX.Element {
    const [tab, setTab] = useMainTab()
    return <MainTabs active={tab} onSelect={setTab} />
  }

  it('padrão Conversa; a escolha vai para o localStorage e volta na próxima abertura', () => {
    const first = render(<Harness />)
    expect(screen.getByRole('tab', { name: /Conversa/ }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: /Escritório/ }))
    expect(localStorage.getItem('agentcode.mainTab')).toBe('office')
    first.unmount()
    render(<Harness />)
    expect(screen.getByRole('tab', { name: /Escritório/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('valor desconhecido (ex.: de outra versão) cai na Conversa', () => {
    localStorage.setItem('agentcode.mainTab', 'office3d')
    expect(loadMainTab()).toBe<MainTab>('chat')
  })
})

describe('OfficeTabHost: o escritório só carrega na 1ª abertura e depois fica montado', () => {
  function fakeRenderer(): RendererLike & { disposed: boolean } {
    return { disposed: false, setPixelRatio() {}, setSize() {}, render() {}, dispose() { this.disposed = true } }
  }

  it('fechado desde o início: nada montado; aberto: monta (lazy); alternar 5× mantém o mesmo motor; desmontar libera', async () => {
    const renderers: Array<ReturnType<typeof fakeRenderer>> = []
    const engineOptions: EngineOptions = {
      raf: () => 1,
      caf: () => {},
      source: { getSnapshot: () => null, subscribe: () => () => {} },
      createRenderer: () => (renderers.push(fakeRenderer()), renderers[renderers.length - 1])
    }
    const ui = (active: boolean): JSX.Element => (
      <OfficeTabHost active={active} chat={active ? <div>chat</div> : null} conversation={null} onOpenConversation={vi.fn()} onOpenFile={vi.fn()} engineOptions={engineOptions} />
    )
    const view = render(ui(false))
    expect(view.container.innerHTML).toBe('')
    view.rerender(ui(true))
    // O chunk do escritório (three + as linhas do chat) pode levar mais de 1 s para carregar com a suíte inteira rodando.
    const ws = await screen.findByTestId('office3d-workspace', undefined, { timeout: 15_000 })
    expect(ws.hidden).toBe(false)
    expect(renderers).toHaveLength(1)
    for (let i = 0; i < 5; i++) {
      view.rerender(ui(false))
      expect(screen.getByTestId('office3d-workspace').hidden).toBe(true)
      view.rerender(ui(true))
      expect(screen.getByTestId('office3d-workspace').hidden).toBe(false)
    }
    expect(renderers).toHaveLength(1)
    expect(screen.getByTestId('office3d-workspace')).toBe(ws)
    view.unmount()
    expect(renderers[0].disposed).toBe(true)
  })
})

describe('OfficeErrorBoundary: uma falha no 3D não derruba o app', () => {
  let fail = true
  function Flaky(): JSX.Element {
    if (fail) throw new Error('WebGL sumiu')
    return <div>escritório de pé</div>
  }
  function Harness(): JSX.Element {
    const [tab, setTab] = useMainTab()
    return (
      <>
        <MainTabs active={tab} onSelect={setTab} />
        <OfficeErrorBoundary active={tab === 'office'} onBack={() => setTab('chat')}>
          <Flaky />
        </OfficeErrorBoundary>
      </>
    )
  }

  it('aviso no lugar do escritório (a aba gravada vira Conversa); "Voltar para a Conversa" troca; reabrir tenta de novo', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fail = true
    localStorage.setItem('agentcode.mainTab', 'office')
    render(<Harness />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('O Escritório 3D falhou: WebGL sumiu')
    // Já gravada: reiniciar o app agora abre na Conversa, não num escritório quebrado.
    expect(localStorage.getItem('agentcode.mainTab')).toBe('chat')
    expect(screen.getByRole('tab', { name: /Escritório/ }).getAttribute('aria-selected')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Voltar para a Conversa' }))
    expect(screen.getByRole('tab', { name: /Conversa/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(localStorage.getItem('agentcode.mainTab')).toBe('chat')

    // Reabrir a aba remonta o escritório (desta vez ele sobe).
    fail = false
    fireEvent.click(screen.getByRole('tab', { name: /Escritório/ }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('escritório de pé')).toBeTruthy()
  })

  it('com a aba fechada a falha não mostra nada (o aviso só aparece na aba Escritório)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fail = true
    const view = render(
      <OfficeErrorBoundary active={false} onBack={vi.fn()}>
        <Flaky />
      </OfficeErrorBoundary>
    )
    expect(view.container.innerHTML).toBe('')
  })
})
