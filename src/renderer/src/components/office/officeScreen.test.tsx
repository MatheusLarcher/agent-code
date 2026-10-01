// Tela do monitor no escritório: abre no nível 'tela', fecha ao afastar,
// duplo clique no monitor e "sem tela, nenhuma assinatura no liveInput".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { conv, feed } from '../../office/adapter/testFeed'
import { TILE_SIZE } from '../../office/engine'
import { liveInput, type ToolInputDelta } from '../../office/liveInput'
import { officeStore } from '../../office/officeStore'
import { UiProvider } from '../../ui/UiProvider'
import { OfficePanel } from './OfficePanel'
import { getOfficeRuntime, resetOfficeRuntime } from './officeRuntime'
import { OfficeView, type OfficeViewCallbacks } from './officeView'

const noRaf = { raf: vi.fn(() => 1), caf: vi.fn(), dpr: () => 1 }
const ev: ToolInputDelta = { kind: 'tool-input-delta', toolUseId: 'u', name: 'Write', filePath: 'a.ts', newText: 'x', totalLines: 1, done: false }

beforeEach(() => {
  resetOfficeRuntime()
  officeStore.setOverride(null)
  officeStore.publish(feed({ conversations: [conv('a', { updatedAt: Date.now() })], activeId: 'a' }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function cbs(): OfficeViewCallbacks {
  return { onHover: vi.fn(), onSelect: vi.fn(), onOpen: vi.fn(), onFocusRequest: vi.fn(), onLevel: vi.fn(), onScreen: vi.fn() }
}

describe('OfficeView: tela do monitor', () => {
  it('abre no nível tela com personagem em foco e fecha ao afastar', () => {
    const cb = cbs()
    const view = new OfficeView(document.createElement('canvas'), null, getOfficeRuntime(), cb, noRaf)
    const rt = getOfficeRuntime()
    const id = rt.director.idOf('conv:a')!
    view.setLevel('tela')
    expect(cb.onScreen).not.toHaveBeenCalled() // sem foco, sem tela
    rt.state.selectedAgentId = id
    view.setLevel('mesa')
    view.zoomStep(1)
    expect(cb.onScreen).toHaveBeenLastCalledWith(expect.objectContaining({ charId: id }))
    expect(view.screenRect()).not.toBeNull()
    view.zoomStep(-1)
    expect(cb.onScreen).toHaveBeenLastCalledWith(null)
    expect(view.screenTarget).toBeNull()
    view.dispose()
  })

  it('duplo clique no monitor de uma mesa abre a tela no nível tela', () => {
    const cb = cbs()
    const view = new OfficeView(document.createElement('canvas'), null, getOfficeRuntime(), cb, noRaf)
    const { state } = getOfficeRuntime()
    // Um ponto do monitor (um tile acima do footprint) sem personagem por cima.
    let desk: (typeof state.layout.furniture)[number] | undefined
    let point = { x: 0, y: 0 }
    for (const f of state.layout.furniture) {
      if (f.kind !== 'mesa') continue
      const p = { x: f.col * TILE_SIZE + 2, y: (f.row - 1) * TILE_SIZE + 2 }
      if (state.getCharacterAt(p.x, p.y) === null) {
        desk = f
        point = p
        break
      }
    }
    expect(desk).toBeDefined()
    view.setLevel('sala')
    view.openAt(point)
    expect(view.currentLevel).toBe('tela')
    expect(cb.onScreen).toHaveBeenLastCalledWith(expect.objectContaining({ deskUid: desk!.uid }))
    expect(cb.onOpen).not.toHaveBeenCalled()
    view.dispose()
  })
})

describe('OfficePanel: tela', () => {
  it('sem a tela, nenhuma assinatura no liveInput; com ela, assina; afastar fecha e descarta', () => {
    render(
      <UiProvider>
        <OfficePanel active={false} onOpenConversation={vi.fn()} onFocusRequest={vi.fn()} viewOptions={noRaf} />
      </UiProvider>
    )
    liveInput.push('a', ev)
    expect(liveInput.latest('a', null)).toBeUndefined()
    expect(screen.queryByTestId('office-screen')).toBeNull()

    const rt = getOfficeRuntime()
    rt.state.selectedAgentId = rt.director.idOf('conv:a')!
    const plus = screen.getByTitle('Aproximar')
    while (!(plus as HTMLButtonElement).disabled) fireEvent.click(plus)
    expect(screen.getByTestId('office-screen')).toBeTruthy()
    act(() => liveInput.push('a', ev))
    expect(liveInput.latest('a', null)).toEqual(ev)

    fireEvent.click(screen.getByTitle('Afastar'))
    expect(screen.queryByTestId('office-screen')).toBeNull()
    liveInput.push('a', ev)
    expect(liveInput.latest('a', null)).toBeUndefined()
  })
})
