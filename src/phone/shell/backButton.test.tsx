/**
 * Botão voltar do Android: a pilha (prioridade, empate pelo mais recente, um passo
 * por toque), a raiz minimiza, o pedido pendente fica intacto, e sem a ponte do
 * Capacitor (navegador) nada é ligado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { client, nav } from '../app/runtime'
import { resetApp } from '../app/testSupport'
import { CENTRAL_CONV_ID } from '../core/client'
import type { ConvSummary } from '../core/types'
import { BACK, handleBack, registerBack } from './backButton'
import { Shell } from './Shell'

type BackCb = (data: unknown, err?: unknown) => void

/** O "APK": a ponte nativa com o App plugin; devolve o toque e as chamadas nativas. */
function fakeBridge(plugins = ['App']): { press: BackCb | null; native: ReturnType<typeof vi.fn>; addListener: ReturnType<typeof vi.fn> } {
  const out = { press: null as BackCb | null, native: vi.fn(() => Promise.resolve({})), addListener: vi.fn() }
  out.addListener.mockImplementation((_p: string, _e: string, cb: BackCb) => {
    out.press = cb
    return { remove: () => undefined }
  })
  window.Capacitor = { nativePromise: out.native, addListener: out.addListener, PluginHeaders: plugins.map((name) => ({ name })) }
  return out
}

/** Módulo novo a cada teste (o `installed` é por carga da página). */
async function freshModule(): Promise<typeof import('./backButton')> {
  vi.resetModules()
  return import('./backButton')
}

describe('pilha do voltar', () => {
  const offs: Array<() => void> = []
  afterEach(() => offs.splice(0).forEach((off) => off()))

  it('a maior prioridade primeiro, um passo por toque; vazia = raiz (false)', () => {
    const calls: string[] = []
    offs.push(registerBack(BACK.screen, () => void calls.push('chat')))
    const offModal = registerBack(BACK.modal, () => {
      calls.push('modal')
      offModal() // a folha fechou: sai da pilha
    })
    offs.push(registerBack(BACK.focus, () => false)) // nada focado: passa adiante
    expect(handleBack()).toBe(true)
    expect(calls).toEqual(['modal'])
    expect(handleBack()).toBe(true)
    expect(calls).toEqual(['modal', 'chat'])
    offs.splice(0).forEach((off) => off())
    expect(handleBack()).toBe(false)
  })

  it('na mesma faixa vence o registro mais recente (o que abriu por cima)', () => {
    const calls: string[] = []
    offs.push(registerBack(BACK.modal, () => void calls.push('configurações')))
    offs.push(registerBack(BACK.modal, () => void calls.push('leitor')))
    handleBack()
    expect(calls).toEqual(['leitor'])
  })
})

describe('ponte nativa', () => {
  afterEach(() => {
    delete window.Capacitor
  })

  it('sem window.Capacitor (navegador) nada é ligado', async () => {
    const m = await freshModule()
    delete window.Capacitor
    expect(() => m.installBackButton()).not.toThrow()
    expect(m.backButtonAvailable()).toBe(false)
  })

  it('APK sem o @capacitor/app compilado: não ouve (o voltar padrão continua)', async () => {
    const m = await freshModule()
    const b = fakeBridge(['ParakeetStt'])
    m.installBackButton()
    expect(b.addListener).not.toHaveBeenCalled()
  })

  it('raiz minimiza (nunca encerra); com tela registrada, ela volta e não minimiza; erro da ponte não é toque', async () => {
    const m = await freshModule()
    const b = fakeBridge()
    m.installBackButton()
    m.installBackButton() // uma vez só
    expect(b.addListener).toHaveBeenCalledTimes(1)
    expect(b.addListener).toHaveBeenCalledWith('App', 'backButton', expect.any(Function))
    b.press!({ canGoBack: false })
    expect(b.native).toHaveBeenCalledWith('App', 'minimizeApp')
    b.native.mockClear()
    const back = vi.fn()
    const off = m.registerBack(m.BACK.screen, back)
    b.press!({ canGoBack: false })
    expect(back).toHaveBeenCalledTimes(1)
    expect(b.native).not.toHaveBeenCalled()
    b.press!(null, { message: 'falhou' })
    expect(back).toHaveBeenCalledTimes(1)
    off()
  })
})

describe('telas registradas (Shell)', () => {
  const PERM = { id: 'p1', toolName: 'Bash', input: { command: 'rm -rf x' } } as unknown as ConvSummary['permission']
  const conv = (id: string, extra: Partial<ConvSummary> = {}): ConvSummary =>
    ({ id, title: `Conversa ${id}`, cwd: 'C:/proj/alfa', updatedAt: 1, ...extra }) as ConvSummary

  beforeEach(() => {
    resetApp()
    client.store.set({
      screen: 'main',
      loaded: true,
      convId: 'a1',
      conversations: [conv(CENTRAL_CONV_ID, { title: 'Central', cwd: '' }), conv('a1', { permission: PERM })],
      projects: []
    })
    nav.set({ tab: 'conversas', chatOpen: true })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('Configurações por cima do chat → fecha; chat → lista; lista → raiz. O pedido pendente fica intacto', () => {
    const respond = vi.spyOn(client, 'permissionRespond')
    render(<Shell />)
    act(() => nav.set({ statusMenuOpen: true }))
    act(() => void handleBack())
    expect(nav.get().statusMenuOpen).toBe(false)
    expect(nav.get().chatOpen).toBe(true)
    act(() => nav.set({ settingsOpen: true }))
    act(() => void handleBack())
    expect(nav.get().settingsOpen).toBe(false)
    expect(nav.get().chatOpen).toBe(true)
    act(() => void handleBack())
    expect(nav.get().chatOpen).toBe(false)
    expect(document.querySelector('.list-view')).toBeTruthy()
    let root = true
    act(() => {
      root = !handleBack()
    })
    expect(root).toBe(true)
    // Nem respondido nem descartado: o PC segue esperando e a conversa segue com o pedido.
    expect(respond).not.toHaveBeenCalled()
    expect(client.store.get().conversations.find((c) => c.id === 'a1')?.permission).toBe(PERM)
  })
})
