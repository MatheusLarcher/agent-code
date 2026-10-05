import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { demoFeed } from '../demoFeed'
import { DEMO_LOOP_MS } from '../demoTimeline'
import { Office3DEngine, type RendererLike } from '../engine'
import { BOARD_KEY, type BoardOpen } from '../engineTypes'
import { BOARD_AT } from '../engineTv'
import { OfficeScene } from '../scene'
import { roomIdFor } from '../../office/adapter/model'
import type { Office3DLayout } from '../layout'
import type { PointerHooks } from '../pointerInput'
import { columnAt, slotPos, TAB_KEY, tabX, TITLE_Y } from './boardLayout'
import { at, fakeBoardApi, item, settle } from './boardTestKit'
import { BoardView } from './boardView'

const T0 = 14_916_667 * DEMO_LOOP_MS

function renderer(): RendererLike {
  return { setPixelRatio() {}, setSize() {}, render() {}, dispose() {}, shadowMap: { autoUpdate: false, needsUpdate: false } }
}

async function setup(items = [item('a', { conversationId: 'demo-0-0', updatedAt: at(0) }), item('b', { sourceStatus: 'in_progress', updatedAt: at(0) })]) {
  vi.setSystemTime(T0 + 30_000)
  const container = document.createElement('div')
  document.body.appendChild(container)
  Object.defineProperty(container, 'clientWidth', { get: () => 1600 })
  Object.defineProperty(container, 'clientHeight', { get: () => 900 })
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900, x: 0, y: 0, toJSON: () => ({}) })
  const feed = demoFeed(T0 + 30_000)
  const fake = fakeBoardApi({ available: true, items })
  const opened: BoardOpen[] = []
  const queue: FrameRequestCallback[] = []
  let t = 0
  const engine = new Office3DEngine(
    container,
    canvas,
    { onFocus: vi.fn(), onOpen: vi.fn(), onBoardOpen: (o) => opened.push(o) },
    { createRenderer: renderer, raf: (cb) => queue.push(cb), caf: () => {}, now: () => t, source: { getSnapshot: () => feed, subscribe: () => () => {} }, board: fake.api, browser: null }
  )
  await settle()
  const flush = (n: number): void => {
    for (let i = 0; i < n; i++) {
      t += 16
      for (const cb of queue.splice(0)) cb(t)
    }
  }
  const rooms = engine.board.sync.roomIds
  const view = (): BoardView => engine.scene.boards.view(engine.scene.boards.roomOfCard('a') as string) as BoardView
  /** A câmera de perto do quadro (PERTO: o texto à vista, dá para pegar o papel), mesmo depois dos quadros do enquadramento geral. */
  const close = (): unknown => vi.spyOn(engine.scene.boards, 'level').mockReturnValue(0)
  return { engine, canvas, container, fake, opened, flush, rooms, view, close }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  }
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('o Quadro real no motor (engineBoard)', () => {
  it('abre com o quadro cheio: uma leitura por sala (o cwd dela), papéis na parede, sem replay', async () => {
    const s = await setup()
    expect(s.rooms.length).toBeGreaterThan(1)
    expect(s.fake.api.boardList.calls.length).toBe(s.rooms.length)
    expect(new Set(s.fake.api.boardList.calls.map((c) => c[0].projectCwd)).size).toBe(s.rooms.length)
    expect(s.engine.board.sync.steps.size).toBe(0)
    expect(s.view().has('a') && s.view().has('b')).toBe(true)
    s.engine.dispose()
  })

  it('mudança do agente no Quadro: o principal vai ao quadro, prende na coluna nova, fala e volta; aba fechada não lê e a volta vai direto', async () => {
    const s = await setup()
    s.fake.state.board = { available: true, items: [item('a', { conversationId: 'demo-0-0', sourceStatus: 'completed', revision: 2, updatedAt: at(5) }), item('b', { sourceStatus: 'in_progress', updatedAt: at(0) })] }
    s.fake.emit('p1')
    await settle()
    const v = s.view()
    const agent = s.engine.scene.crowd.brains.get('conv:demo-0-0')
    // Ainda na coluna velha: o agente da conversa dona levanta e vai levar o papel.
    expect(v.columnOf('a')).toBe(0)
    expect(agent?.errand).not.toBeNull()
    const said: string[] = []
    for (let i = 0; i < 80 && agent?.errand; i++) {
      s.flush(16)
      vi.advanceTimersByTime(250)
      const q = s.container.querySelector('.qb[data-kind="board"]')?.textContent
      if (q && !said.includes(q)) said.push(q)
    }
    expect(agent?.errand).toBeNull()
    expect(v.columnOf('a')).toBe(2)
    expect(said.some((t) => t.includes('Concluí:'))).toBe(true)
    s.flush(80)
    expect(v.busy('a')).toBe(false)
    const reads = s.fake.api.boardList.calls.length
    s.engine.pause()
    s.fake.state.board = { available: true, items: [item('a', { conversationId: 'demo-0-0', updatedAt: at(9), revision: 3 }), item('b', { sourceStatus: 'in_progress', updatedAt: at(0) })] }
    s.fake.emit('p1')
    await settle()
    expect(s.fake.api.boardList.calls.length).toBe(reads)
    s.engine.resume()
    await settle()
    expect(s.view().columnOf('a')).toBe(0)
    expect(s.view().busy('a')).toBe(false) // direto, sem animar o intervalo
    s.engine.dispose()
  })

  it('clique no quadro de longe foca o quadro; com ele em foco, o papel abre o cartão e a pilha a lista; hover mostra o nome', async () => {
    const s = await setup()
    const pick = vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue('card:a')
    const click = (x: number, y: number): void => {
      fireEvent.pointerDown(s.canvas, { button: 0, clientX: x, clientY: y })
      fireEvent.pointerUp(window, { button: 0, clientX: x, clientY: y })
    }
    // Fora do foco, o 1º clique (no papel ou no fundo) leva a câmera ao quadro e não abre nada.
    click(302, 200)
    expect(s.engine.focused).toBe(BOARD_KEY)
    expect(s.opened).toEqual([])
    // De frente para o quadro (yaw 0, sem arfagem), no centro dele; a vista inicial fecha o foco.
    s.flush(40)
    expect(s.engine.rig.pose).toMatchObject({ tx: BOARD_AT.x, tz: BOARD_AT.z, yaw: 0, pitch: 0 })
    s.engine.resetView()
    expect(s.engine.focused).toBeNull()
    pick.mockReturnValue(BOARD_KEY)
    click(302, 200)
    expect(s.engine.focused).toBe(BOARD_KEY)
    pick.mockReturnValue('card:a')
    click(302, 200)
    expect(s.opened).toEqual([{ kind: 'card', id: 'a', x: 302, y: 200 }])
    pick.mockReturnValue(`pile:${s.rooms[0]}|completed`)
    fireEvent.pointerDown(s.canvas, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(window, { button: 0, clientX: 10, clientY: 10 })
    expect(s.opened[1]).toMatchObject({ kind: 'pile', roomId: s.rooms[0], status: 'completed' })
    pick.mockReturnValue('card:a')
    fireEvent.pointerMove(s.canvas, { clientX: 400, clientY: 300 })
    const tip = s.container.querySelector<HTMLElement>('.o3d-board-tip')
    expect(tip?.hidden).toBe(false)
    expect(tip?.textContent).toBe(s.engine.board.title('demo-0-0'))
    expect(s.canvas.style.cursor).toBe('grab')
    expect(s.engine.board.open('a')).toBe(true)
    expect(s.engine.board.open('nao-existe')).toBe(false)
    s.engine.dispose()
  })

  it('arrastar para outra coluna chama boardMove (otimista); recusa volta tremendo com a mensagem do main', async () => {
    const s = await setup()
    s.close()
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue('card:a')
    const target = slotPos(1, 0)
    vi.spyOn(BoardView.prototype, 'localPoint').mockImplementation((_ray, out) => {
      out.x = target.x
      out.y = target.y
      return true
    })
    fireEvent.pointerDown(s.canvas, { button: 0, clientX: 300, clientY: 200 })
    fireEvent.pointerMove(window, { clientX: 340, clientY: 200 })
    expect(s.canvas.style.cursor).toBe('grabbing')
    expect(s.view().dragging).toBe('a')
    fireEvent.pointerUp(window, { button: 0, clientX: 360, clientY: 200 })
    expect(s.fake.api.boardMove.calls).toEqual([['a', 'in_progress']])
    expect(s.view().columnOf('a')).toBe(1) // otimista
    // O main grava; a releitura confirma (e o papel não reanima: já está lá).
    s.fake.state.board = { available: true, items: [item('a', { conversationId: 'demo-0-0', poStatus: 'in_progress', revision: 2, updatedAt: at(6) }), item('b', { sourceStatus: 'in_progress', updatedAt: at(0) })] }
    await settle()
    expect(s.engine.board.message).toBeNull()
    expect(s.engine.board.sync.mirror(s.engine.scene.boards.roomOfCard('a') as string)?.pending).toBe(0)

    // Recusa: volta para a coluna real e a mensagem sobe perto do quadro.
    s.flush(80)
    s.fake.state.moveResult = { ok: false, message: 'Abra esta conversa e mande uma mensagem para o agente começar antes de mover pelo quadro.' }
    vi.mocked(BoardView.prototype.localPoint).mockImplementation((_ray, out) => {
      const done = slotPos(2, 0)
      out.x = done.x
      out.y = done.y
      return true
    })
    const before = s.view().columnOf('a')
    fireEvent.pointerDown(s.canvas, { button: 0, clientX: 300, clientY: 200 })
    fireEvent.pointerMove(window, { clientX: 340, clientY: 200 })
    fireEvent.pointerUp(window, { button: 0, clientX: 360, clientY: 200 })
    await settle()
    expect(s.view().columnOf('a')).toBe(before)
    expect(s.engine.board.message).toContain('Abra esta conversa')
    expect(s.container.querySelector<HTMLElement>('.o3d-board-toast')?.hidden).toBe(false)
    s.engine.dispose()
  })

  it('Esc cancela o arrasto (sem boardMove); soltar fora do quadro ou na mesma coluna volta', async () => {
    const s = await setup()
    s.close()
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue('card:a')
    const point = { x: slotPos(2, 0).x, y: slotPos(2, 0).y }
    vi.spyOn(BoardView.prototype, 'localPoint').mockImplementation((_ray, out) => {
      out.x = point.x
      out.y = point.y
      return true
    })
    fireEvent.pointerDown(s.canvas, { button: 0, clientX: 300, clientY: 200 })
    fireEvent.pointerMove(window, { clientX: 340, clientY: 200 })
    const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
    window.dispatchEvent(esc)
    expect(esc.defaultPrevented).toBe(true)
    expect(s.view().dragging).toBeNull()
    fireEvent.pointerUp(window, { button: 0, clientX: 360, clientY: 200 })
    // Fora do quadro e na mesma coluna: o papel volta.
    for (const p of [{ x: 9, y: 9 }, { x: slotPos(0, 2).x, y: slotPos(0, 2).y }]) {
      s.flush(80)
      Object.assign(point, p)
      fireEvent.pointerDown(s.canvas, { button: 0, clientX: 300, clientY: 200 })
      fireEvent.pointerMove(window, { clientX: 340, clientY: 200 })
      expect(s.view().dragging).toBe('a')
      fireEvent.pointerUp(window, { button: 0, clientX: 360, clientY: 200 })
      expect(s.view().dragging).toBeNull()
    }
    expect(columnAt(9, 9)).toBeNull()
    expect(s.fake.api.boardMove.calls).toEqual([])
    expect(s.view().columnOf('a')).toBe(0)
    s.engine.dispose()
  })

  it('fora do papel (ou de longe) o botão esquerdo continua girando a câmera', async () => {
    const s = await setup()
    const pick = vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(null)
    const orbit = vi.spyOn(s.engine.rig, 'orbit')
    fireEvent.pointerDown(s.canvas, { button: 0, clientX: 300, clientY: 200 })
    fireEvent.pointerMove(window, { clientX: 340, clientY: 200 })
    fireEvent.pointerUp(window, { button: 0, clientX: 340, clientY: 200 })
    expect(orbit).toHaveBeenCalled()
    // Papel de longe (sem texto): não pega, gira.
    orbit.mockClear()
    pick.mockReturnValue('card:a')
    vi.spyOn(s.engine.scene.boards, 'level').mockReturnValue(1)
    fireEvent.pointerDown(s.canvas, { button: 0, clientX: 300, clientY: 200 })
    fireEvent.pointerMove(window, { clientX: 340, clientY: 200 })
    fireEvent.pointerUp(window, { button: 0, clientX: 340, clientY: 200 })
    expect(orbit).toHaveBeenCalled()
    expect(s.view().dragging).toBeNull()
    s.engine.dispose()
  })
  it('a parede mostra o projeto da conversa ativa com as abas; a aba troca até a conversa mudar; com filtro, o filtrado', async () => {
    const s = await setup()
    const boards = s.engine.scene.boards
    const feed = s.engine.currentFeed!
    const layout = (s.engine as unknown as { layout: Office3DLayout }).layout
    const active = feed.conversations.find((c) => c.id === feed.activeId)!
    expect(boards.shown).toBe(roomIdFor(active.cwd))
    // As abas: uma por projeto com quadro, na faixa do título (o clique acha pela posição).
    const n = s.rooms.length
    const view = boards.view(boards.shown!)!
    const tabs = Array.from({ length: n }, (_, i) => view.keyAt(0, { x: tabX(i, n), y: TITLE_Y }))
    expect(tabs).toEqual(s.rooms.map((id) => `${TAB_KEY}${id}`))
    expect(view.keyAt(0, { x: 0, y: 0 })).toBeNull()
    const other = s.rooms.find((id) => id !== boards.shown)!
    const hooks = s.engine.board.wrap({ click: vi.fn(), hover: vi.fn() } as unknown as PointerHooks, () => BOARD_KEY)
    hooks.click(`${TAB_KEY}${other}`)
    expect(boards.shown).toBe(other)
    s.engine.board.feed(feed, layout)
    expect(boards.shown).toBe(other)
    const next = feed.conversations.find((c) => c.cwd && roomIdFor(c.cwd) !== other && roomIdFor(c.cwd) !== roomIdFor(active.cwd))!
    s.engine.board.feed({ ...feed, activeId: next.id }, layout)
    expect(boards.shown).toBe(roomIdFor(next.cwd))
    // Filtro: o filtrado, e a aba não tira.
    s.engine.setProjectFilter(other)
    expect(boards.shown).toBe(other)
    hooks.click(`${TAB_KEY}${roomIdFor(active.cwd)}`)
    expect(boards.shown).toBe(other)
    s.engine.setProjectFilter(null)
    expect(boards.shown).toBe(roomIdFor(active.cwd))
    s.engine.dispose()
  })
})
