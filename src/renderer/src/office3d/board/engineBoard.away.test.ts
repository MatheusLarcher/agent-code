import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Vector3 } from 'three'
import { demoFeed } from '../demoFeed'
import { DEMO_LOOP_MS } from '../demoTimeline'
import { Office3DEngine, type RendererLike } from '../engine'
import { roomIdFor } from '../../office/adapter/model'
import { awayAnnounce } from './awayAnnounce'
import { AWAY_SAY_MS } from './engineBoard'
import { at, fakeBoardApi, item, settle } from './boardTestKit'

/**
 * O resumo "desde que você saiu" no escritório: o PO do projeto diz a versão
 * curta no balão do quadro quando a cabeça dele aparece na tela, com a janela
 * em foco — uma vez por resumo; fora da tela (ou sem foco), espera.
 */

const T0 = 14_916_667 * DEMO_LOOP_MS
const CWD = 'C:/demo/loja'

function renderer(): RendererLike {
  return { setPixelRatio() {}, setSize() {}, render() {}, dispose() {}, shadowMap: { autoUpdate: false, needsUpdate: false } }
}

async function setup() {
  vi.setSystemTime(T0 + 30_000)
  const container = document.createElement('div')
  document.body.appendChild(container)
  Object.defineProperty(container, 'clientWidth', { get: () => 1600 })
  Object.defineProperty(container, 'clientHeight', { get: () => 900 })
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  const feed = demoFeed(T0 + 30_000)
  const fake = fakeBoardApi({ available: true, items: [item('a', { conversationId: 'demo-0-0', updatedAt: at(0) })] })
  const engine = new Office3DEngine(
    container,
    canvas,
    { onFocus: vi.fn(), onOpen: vi.fn() },
    { createRenderer: renderer, raf: () => 0, caf: () => {}, now: () => 0, source: { getSnapshot: () => feed, subscribe: () => () => {} }, board: fake.api, browser: null }
  )
  await settle()
  engine.camera.updateMatrixWorld()
  const po = `po:${roomIdFor(CWD)}`
  /** A cabeça do PO: `ahead` metros à frente da câmera (negativo: atrás dela). */
  const headAt = (ahead: number): void => {
    const dir = engine.camera.getWorldDirection(new Vector3())
    const spot = engine.camera.position.clone().addScaledVector(dir, ahead)
    vi.spyOn(engine.scene, 'headWorldPosition').mockImplementation((key, out) => key === po && !!out.copy(spot))
  }
  const announce = vi.spyOn(engine.board.stage, 'announce')
  return { engine, po, headAt, announce }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  }
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  awayAnnounce.reset()
})

afterEach(() => {
  awayAnnounce.reset()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('o PO diz o resumo no escritório (engineBoard + awayAnnounce)', () => {
  it('cabeça do PO na tela: o balão do quadro com a versão curta, uma vez só, e quem lê em voz alta é avisado', async () => {
    const s = await setup()
    const said = vi.fn()
    awayAnnounce.onSaid(said)
    awayAnnounce.publish([{ id: 'r1', cwd: CWD, text: 'Desde que você saiu: 3 concluídas e 1 falhou.' }])
    s.headAt(5)
    s.engine.board.tick()
    expect(s.announce).toHaveBeenCalledWith(s.po, 'Desde que você saiu: 3 concluídas e 1 falhou.', expect.any(String), AWAY_SAY_MS)
    expect(said).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }))
    // O mesmo resumo publicado de novo (o App republica a cada mudança) não é dito outra vez.
    awayAnnounce.publish([{ id: 'r1', cwd: CWD, text: 'x' }])
    s.engine.board.tick()
    expect(s.announce).toHaveBeenCalledTimes(1)
    s.engine.dispose()
  })

  it('cabeça fora da tela (atrás da câmera) ou janela sem foco: espera', async () => {
    const s = await setup()
    awayAnnounce.publish([{ id: 'r2', cwd: CWD, text: 'Desde que você saiu: 1 concluída.' }])
    s.headAt(-5)
    s.engine.board.tick()
    expect(s.announce).not.toHaveBeenCalled()

    s.headAt(5)
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    s.engine.board.tick()
    expect(s.announce).not.toHaveBeenCalled()
    expect(awayAnnounce.pending()).toHaveLength(1)
    s.engine.dispose()
  })
})
