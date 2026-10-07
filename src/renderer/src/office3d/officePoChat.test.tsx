import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { syntheticFeed } from '../components/office/devFeed'
import type { OfficeFeed } from '../office/adapter/feed'
import { deriveOfficeModel } from '../office/adapter/model'
import { poChatOpen, projectNameOf } from '../poChat/poChatOpen'
import type { EngineOptions, FeedSource, Office3DEngine, RendererLike } from './engine'
import { layoutOffice } from './layout'
import { Office3DWorkspace } from './Office3DWorkspace'
import { openPoChat } from './officePoChat'
import { OfficeScene } from './scene'

const renderer = (): RendererLike => ({ setPixelRatio() {}, setSize() {}, render() {}, dispose() {} })
const source = (feed: OfficeFeed): FeedSource => ({ getSnapshot: () => feed, subscribe: () => () => {} })
const raf = (): Pick<EngineOptions, 'raf' | 'caf' | 'now'> => ({ raf: () => 1, caf: () => {}, now: () => 0 })

/** O feed de DEV com o PO ligado e um diagnóstico dele na 1ª conversa (o PO aparece na sala dela). */
function feedWithPo(): OfficeFeed {
  const f = syntheticFeed()
  return { ...f, observersOn: { po: true, vigia: false, memorista: false }, poDiagnostics: { [f.conversations[0].id]: { phase: 'audit-started', at: Date.now() } as never } }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  }
  poChatOpen.set(null)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  poChatOpen.set(null)
})

describe('poChatOpen: onde o "Fala, PO" está aberto', () => {
  it('guarda a pasta, avisa quem assina (só quando muda) e dá o nome curto do projeto', () => {
    const seen: Array<string | null> = []
    const off = poChatOpen.subscribe(() => seen.push(poChatOpen.get()))
    poChatOpen.set('C:\\GitHub\\loja')
    poChatOpen.set('C:\\GitHub\\loja')
    poChatOpen.set(null)
    off()
    poChatOpen.set('C:/x')
    expect(seen).toEqual(['C:\\GitHub\\loja', null])
    expect(projectNameOf('C:\\GitHub\\loja\\')).toBe('loja')
  })
})

describe('openPoChat: o clique no PO do escritório', () => {
  const engine = (spot: string): Office3DEngine & { leaveFocus: ReturnType<typeof vi.fn> } =>
    ({
      scene: { character: () => ({ spot, model: { convId: 'k1' } }) },
      currentFeed: { conversations: [{ id: 'k1', cwd: 'C:\\GitHub\\loja' }] },
      leaveFocus: vi.fn()
    }) as never

  it('no PO: abre o chat do projeto dele e fecha o foco do motor (sem voltar a câmera)', () => {
    const e = engine('po')
    expect(openPoChat(e, 'po:c:/github/loja')).toBe(true)
    expect(poChatOpen.get()).toBe('C:\\GitHub\\loja')
    expect(e.leaveFocus).toHaveBeenCalledWith(false)
  })

  it('em outro personagem (ou sem motor): não faz nada', () => {
    const e = engine('desk')
    expect(openPoChat(e, 'conv:k1')).toBe(false)
    expect(openPoChat(null, 'po:x')).toBe(false)
    expect(poChatOpen.get()).toBeNull()
    expect(e.leaveFocus).not.toHaveBeenCalled()
  })
})

describe('Office3DWorkspace: clicar no PO abre o "Fala, PO"', () => {
  it('no chat flutuante, com o cabeçalho do PO e o projeto; sem tela de monitor e sem trocar a conversa ativa', () => {
    const feed = feedWithPo()
    const po = layoutOffice(deriveOfficeModel(feed, Date.now())).characters.find((c) => c.spot === 'po')!
    const cwd = feed.conversations.find((c) => c.id === po.model.convId)!.cwd
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(po.key)
    const onOpen = vi.fn()
    render(
      <Office3DWorkspace
        chat={<div>painel do chat</div>}
        conversation={{ id: 'outra', title: 'Outra conversa', cwd: 'C:\\outra' }}
        onOpenConversation={onOpen}
        engineOptions={{ ...raf(), source: source(feed), createRenderer: renderer }}
      />
    )
    expect(screen.queryByTestId('o3d-chat-po')).toBeNull()
    const canvas = screen.getByTestId('office3d-canvas')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 51, clientY: 50 })
    expect(poChatOpen.get()).toBe(cwd)
    const head = screen.getByTestId('o3d-chat-po')
    expect(head.textContent).toBe(`Fala, PO${projectNameOf(cwd)}`)
    expect(screen.getByText('painel do chat')).toBeTruthy()
    expect(screen.queryByTestId('office-screen')).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
    // "Voltar" do painel (fecha o chat do PO): o cabeçalho volta a ser o da conversa.
    act(() => poChatOpen.set(null))
    expect(screen.queryByTestId('o3d-chat-po')).toBeNull()
    expect(screen.getByText('Outra conversa')).toBeTruthy()
  })
})
