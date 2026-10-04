/**
 * A tela do monitor como chat: foco no agente abre a tela no Chat com o campo de
 * digitar (`monitorComposer`, o Composer do App) embaixo, o chat flutuante sai
 * enquanto ela está aberta e volta ao fechar; o rascunho sobrevive à troca
 * Chat/Código (o campo fica montado) e ao fechar (o blur grava antes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { syntheticFeed } from '../components/office/devFeed'
import type { OfficeFeed } from '../office/adapter/feed'
import { deriveOfficeModel } from '../office/adapter/model'
import { UiProvider } from '../ui/UiProvider'
import type { EngineOptions, FeedSource, RendererLike } from './engine'
import { layoutOffice } from './layout'
import { Office3DWorkspace, type Office3DWorkspaceProps } from './Office3DWorkspace'
import { OfficeScene } from './scene'

const renderer = (): RendererLike => ({ setPixelRatio() {}, setSize() {}, render() {}, dispose() {} })
const source = (f: OfficeFeed): FeedSource => ({ getSnapshot: () => f, subscribe: () => () => {} })
const raf: Pick<EngineOptions, 'raf' | 'caf' | 'now'> = { raf: () => 1, caf: () => {}, now: () => 0 }

/** O dublê do Composer do App: estado próprio (como o de verdade) e o rascunho gravado só no blur. */
function FakeComposer({ convId, onDraft, onSend }: { convId: string; onDraft: (id: string, t: string) => void; onSend: (t: string) => void }): JSX.Element {
  const [value, setValue] = useState('')
  return (
    <textarea
      aria-label="Mensagem"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDraft(convId, value)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        onSend(value)
        setValue('')
      }}
    />
  )
}

beforeEach(() => {
  // A tela do monitor lembra o último app no localStorage: cada teste começa do zero.
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
})

function setup(props: Partial<Office3DWorkspaceProps> = {}) {
  const feed = syntheticFeed()
  const target = layoutOffice(deriveOfficeModel(feed, Date.now())).characters.find((c) => c.deskIndex !== null && c.model.active && !c.model.trackId)!
  const convId = target.model.convId
  const pick = vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(target.key)
  const onDraft = vi.fn()
  const onSend = vi.fn()
  const onOpenConversation = vi.fn()
  // Como o App: o campo é o da conversa ativa (o envio vai para ela).
  const all = (conv: string): Office3DWorkspaceProps => ({
    chat: <div>chat flutuante</div>,
    central: <div>central</div>,
    conversation: { id: conv, title: conv, cwd: 'C:\\p' },
    monitorComposer: <FakeComposer key={conv} convId={conv} onDraft={onDraft} onSend={(t) => onSend(conv, t)} />,
    onOpenConversation,
    engineOptions: { ...raf, source: source(feed), createRenderer: renderer },
    ...props
  })
  const view = render(
    <UiProvider>
      <Office3DWorkspace {...all('outra')} />
    </UiProvider>
  )
  const rerender = (conv: string): void =>
    view.rerender(
      <UiProvider>
        <Office3DWorkspace {...all(conv)} />
      </UiProvider>
    )
  const canvas = screen.getByTestId('office3d-canvas')
  const click = (): void => {
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 50, clientY: 50 })
  }
  const float = (): HTMLElement | null => screen.queryByRole('region', { name: 'Escritório' })
  return { convId, pick, onDraft, onSend, onOpenConversation, rerender, click, float }
}

describe('Tela do monitor como chat', () => {
  it('clique no agente: a tela abre no Chat com o campo de digitar; Enter envia pela conversa do agente; o flutuante sai e volta ao fechar', () => {
    const s = setup()
    expect(s.float()?.textContent).toContain('central')
    s.click()
    // O 3D seleciona a conversa dele; o App passa a dar o campo dela.
    expect(s.onOpenConversation).toHaveBeenCalledWith(s.convId)
    s.rerender(s.convId)
    const tela = screen.getByTestId('office-screen')
    expect([tela.dataset.mode, screen.getByRole('button', { name: 'Chat' }).getAttribute('aria-pressed')]).toEqual(['chat', 'true'])
    const box = screen.getByTestId('office-screen-composer')
    expect(box.hidden).toBe(false)
    const ta = screen.getByRole('textbox', { name: 'Mensagem' })
    expect(tela.contains(ta)).toBe(true)
    // Com a tela aberta, o chat flutuante não existe (nem o campo dele).
    expect(s.float()).toBeNull()
    fireEvent.change(ta, { target: { value: 'oi, agente' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(s.onSend).toHaveBeenCalledWith(s.convId, 'oi, agente')
    // Fechar (clique no vazio): a tela sai e o flutuante volta, na Central.
    s.pick.mockReturnValue(null)
    s.click()
    expect(screen.queryByTestId('office-screen')).toBeNull()
    expect(s.float()?.textContent).toContain('central')
  })

  it('a conversa ativa ainda não é a do agente: a tela abre sem o campo (nada vai para a conversa errada)', () => {
    const s = setup()
    s.click()
    expect(screen.getByTestId('office-screen')).toBeTruthy()
    expect(screen.queryByTestId('office-screen-composer')).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Mensagem' })).toBeNull()
    expect(s.float()).toBeNull()
  })

  it('rascunho: trocar para Código e voltar mantém o texto; fechar a tela grava o rascunho (blur) antes de desmontar', () => {
    const s = setup()
    s.click()
    s.rerender(s.convId)
    const ta = screen.getByRole('textbox', { name: 'Mensagem' }) as HTMLTextAreaElement
    ta.focus()
    fireEvent.change(ta, { target: { value: 'meio escrito' } })
    fireEvent.click(screen.getByRole('button', { name: 'Código' }))
    // No Código o campo fica montado e escondido: o texto não se perde.
    expect(screen.getByTestId('office-screen-composer').hidden).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(screen.getByTestId('office-screen-composer').hidden).toBe(false)
    expect((screen.getByRole('textbox', { name: 'Mensagem' }) as HTMLTextAreaElement).value).toBe('meio escrito')
    // Fechar com o campo em foco (o motor fecha a tela): o blur grava antes de a tela sumir.
    ;(screen.getByRole('textbox', { name: 'Mensagem' }) as HTMLTextAreaElement).focus()
    s.onDraft.mockClear()
    s.pick.mockReturnValue(null)
    act(() => s.click())
    expect(s.onDraft).toHaveBeenCalledWith(s.convId, 'meio escrito')
    expect(screen.queryByTestId('office-screen')).toBeNull()
  })

  it('sem monitorComposer (quem não dá o campo): a tela abre no Chat só de leitura e o flutuante continua', () => {
    const s = setup({ monitorComposer: undefined })
    s.click()
    s.rerender(s.convId)
    expect(screen.getByTestId('office-screen').dataset.mode).toBe('chat')
    expect(screen.queryByTestId('office-screen-composer')).toBeNull()
    expect(s.float()).toBeTruthy()
  })
})
