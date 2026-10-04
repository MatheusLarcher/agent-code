/**
 * A tela do monitor focado e a Central: ir à Central (a Central virando a
 * conversa ativa, ou o clique nela de novo via `centralSignal`) fecha a tela
 * como gesto do usuário — a câmera volta e o flutuante aparece na Central. E o
 * seletor de modelo da tela (`monitorModelPicker`) é da conversa do agente
 * focado, não da ativa.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { syntheticFeed } from '../components/office/devFeed'
import { ModelPicker } from '../components/ModelPicker'
import type { OfficeFeed } from '../office/adapter/feed'
import { deriveOfficeModel } from '../office/adapter/model'
import { UiProvider } from '../ui/UiProvider'
import { Office3DEngine, type EngineOptions, type FeedSource, type RendererLike } from './engine'
import { layoutOffice } from './layout'
import { Office3DWorkspace, type Office3DWorkspaceProps } from './Office3DWorkspace'
import { OfficeScene } from './scene'

const renderer = (): RendererLike => ({ setPixelRatio() {}, setSize() {}, render() {}, dispose() {} })
const source = (f: OfficeFeed): FeedSource => ({ getSnapshot: () => f, subscribe: () => () => {} })
const raf: Pick<EngineOptions, 'raf' | 'caf' | 'now'> = { raf: () => 1, caf: () => {}, now: () => 0 }
const CENTRAL = { id: 'central', title: 'Central', cwd: '' }
const MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }
]

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
  vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(target.key)
  const leave = vi.spyOn(Office3DEngine.prototype, 'leaveFocus')
  const onOpenConversation = vi.fn()
  const changeModel = vi.fn()
  // Como o App: o seletor recebe o convId do agente focado e troca o modelo dele.
  const monitorModelPicker = (id: string): JSX.Element => (
    <ModelPicker
      models={MODELS}
      model="claude-opus-4-8"
      modelLocked={false}
      onModelChange={(m) => changeModel(id, m)}
      onModelLockedClick={() => {}}
      effortLevels={[]}
      effort="high"
      effortLocked={false}
      onEffortChange={() => {}}
    />
  )
  const all = (conversation: Office3DWorkspaceProps['conversation'], centralSignal = 0): Office3DWorkspaceProps => ({
    chat: <div>chat flutuante</div>,
    central: <div>central</div>,
    conversation,
    monitorComposer: <textarea aria-label="Mensagem" />,
    monitorModelPicker,
    centralSignal,
    onOpenConversation,
    engineOptions: { ...raf, source: source(feed), createRenderer: renderer },
    ...props
  })
  const view = render(
    <UiProvider>
      <Office3DWorkspace {...all({ id: 'outra', title: 'outra', cwd: 'C:\\p' })} />
    </UiProvider>
  )
  const rerender = (conversation: Office3DWorkspaceProps['conversation'], signal = 0): void =>
    view.rerender(
      <UiProvider>
        <Office3DWorkspace {...all(conversation, signal)} />
      </UiProvider>
    )
  const canvas = screen.getByTestId('office3d-canvas')
  const click = (): void => {
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 50, clientY: 50 })
  }
  const float = (): HTMLElement | null => screen.queryByRole('region', { name: 'Escritório' })
  const agentConv = { id: convId, title: 'agente', cwd: 'C:\\p' }
  return { convId, agentConv, leave, changeModel, onOpenConversation, rerender, click, float }
}

describe('Tela do monitor e a Central', () => {
  it('com a tela aberta, a Central virando a conversa ativa fecha a tela como gesto do usuário e o flutuante volta na Central', () => {
    const s = setup()
    s.click()
    s.rerender(s.agentConv)
    expect(screen.getByTestId('office-screen')).toBeTruthy()
    expect(s.float()).toBeNull()
    s.rerender(CENTRAL)
    // leaveFocus(back, byUser): a câmera volta à vista de antes do foco.
    expect(s.leave).toHaveBeenCalledWith(true, true)
    expect(screen.queryByTestId('office-screen')).toBeNull()
    expect(s.float()?.textContent).toContain('central')
  })

  it('clique na Central com ela já ativa (centralSignal): a tela fecha e o flutuante mostra a Central', () => {
    const s = setup()
    s.rerender(CENTRAL)
    s.click()
    expect(screen.getByTestId('office-screen')).toBeTruthy()
    s.leave.mockClear()
    // A conversa ativa não muda (o App ainda não trocou): só o sinal do clique.
    s.rerender(CENTRAL, 1)
    expect(s.leave).toHaveBeenCalledWith(true, true)
    expect(screen.queryByTestId('office-screen')).toBeNull()
    expect(s.float()?.textContent).toContain('central')
  })

  it('o centralSignal inicial (montagem) não fecha nada', () => {
    const s = setup()
    s.click()
    s.rerender(s.agentConv)
    expect(s.leave).not.toHaveBeenCalledWith(true, true)
    expect(screen.getByTestId('office-screen')).toBeTruthy()
  })

  it('o seletor de modelo da tela é o da conversa do agente focado, mesmo com outra conversa ativa', () => {
    const s = setup()
    s.click()
    // A conversa ativa ainda é "outra": sem campo de digitar, mas com o seletor do agente.
    const box = screen.getByTestId('office-screen-model')
    expect(screen.getByTestId('office-screen').contains(box)).toBe(true)
    expect(screen.queryByRole('textbox', { name: 'Mensagem' })).toBeNull()
    fireEvent.change(within(box).getByRole('combobox', { name: 'Modelo' }), { target: { value: 'claude-sonnet-5-5' } })
    expect(s.changeModel).toHaveBeenCalledWith(s.convId, 'claude-sonnet-5-5')
    // Com a conversa do agente ativa: seletor e campo juntos, na tela.
    s.rerender(s.agentConv)
    expect(within(screen.getByTestId('office-screen-composer')).getByRole('combobox', { name: 'Modelo' })).toBeTruthy()
    expect(within(screen.getByTestId('office-screen-composer')).getByRole('textbox', { name: 'Mensagem' })).toBeTruthy()
  })
})
