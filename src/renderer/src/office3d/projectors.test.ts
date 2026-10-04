import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Material, Object3D, Texture } from 'three'
import { deriveOfficeModel } from '../office/adapter/model'
import { conv, feed } from '../office/adapter/testFeed'
import type { UIMessage } from '../types'
import { Character3D } from './characters'
import { buildRoom, type RoomView } from './decor'
import { PROJECTOR_KEY } from './engineTypes'
import { snapshotOf } from './events'
import { createKit } from './kit'
import { layoutOffice, OFFICE_ID } from './layout'
import { MEETING } from './officePlan'
import { RoomProjector } from './projector'
import { IMG_Y } from './projectorKit'
import { MIN_PAINT_MS, Projectors } from './projectors'
import { PROJECTOR_IDLE_MS } from './projectorUse'
import { OfficeScene } from './scene'
import { fakeBrowserApi, jpegFrame } from './testBrowserApi'

const NOW = 1_800_000_000_000
const URL = 'http://localhost:5173/carrinho'
const MSGS: UIMessage[] = [
  { kind: 'user', id: 'u1', text: 'testa a loja no navegador' },
  { kind: 'tool-use', id: 'n1', name: 'mcp__browser__browser_navigate', input: { url: URL }, parentToolUseId: null, result: { isError: false, text: `Navegou para ${URL} — "Carrinho" (aba: "web - Carrinho").` } },
  { kind: 'tool-use', id: 's1', name: 'mcp__browser__browser_screenshot', input: {}, parentToolUseId: null }
]
const testing = (id = 'a', messages = MSGS) => feed({ conversations: [conv(id, { messages, updatedAt: NOW })], busyIds: new Set([id]), activeId: id })

function setup(f = testing()) {
  const kit = createKit(1)
  const model = deriveOfficeModel(f, NOW)
  const layout = layoutOffice(model)
  const room = layout.rooms[0]
  const views = new Map<string, RoomView>([[room.id, buildRoom(kit, room, () => {})]])
  let dark = false
  let clock = NOW
  const p = new Projectors(kit, () => dark, () => clock)
  p.syncRooms(layout.rooms, views)
  // A TV é do escritório (sala física); o nome do teste é o do projeto (a cena resolve assim).
  p.projectOf = (convId) => (model.characters.some((c) => c.convId === convId) ? 'alpha' : null)
  const physical = model.characters.map((c) => ({ ...c, roomId: OFFICE_ID }))
  const run = (seconds: number): number => {
    let rate = 0
    for (let i = 0; i < seconds * 10; i++) rate = Math.max(rate, p.animate(0.1))
    return rate
  }
  return {
    p, kit, room, model, view: views.get(room.id)!,
    tvLod: views.get(room.id)!.zone('meeting').lod,
    run,
    setDark: (v: boolean) => void (dark = v),
    tick: (ms: number) => {
      clock += ms
      return p.tick(clock)
    },
    get clock() {
      return clock
    },
    feed: (next = f) => p.feed(next, physical, clock)
  }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const keysOf = (p: Projectors): unknown[] => {
  const out: Object3D[] = []
  p.pickTargets(out)
  return out.map((o) => o.userData.charKey)
}

describe('A TV da sala de reunião: liga no uso do navegador e apaga sem uso', () => {
  it('liga e acende com a sala de reunião à vista (avisa uma vez, com o centro da TV); clicável acesa; apaga depois de PROJECTOR_IDLE_MS', () => {
    const s = setup()
    const lit = vi.fn()
    s.p.onLit = lit
    s.feed()
    expect(s.p.isDown(s.room.id)).toBe(true)
    expect(keysOf(s.p)).toEqual([])
    expect(s.run(4)).toBe(2) // acendeu animando
    const fx = s.p.room(s.room.id)!
    expect([fx.drop, fx.lit]).toEqual([1, 1])
    expect(lit).toHaveBeenCalledTimes(1)
    const [id, x, y, z] = lit.mock.calls[0]
    expect([id, x, y]).toEqual([OFFICE_ID, MEETING.tv.x, IMG_Y])
    expect(z).toBeCloseTo(s.view.furniture.tv.z)
    expect(keysOf(s.p)).toContain(`${PROJECTOR_KEY}${s.room.id}`)
    // Parada e acesa: nada anima (render sob demanda).
    expect(s.run(1)).toBe(0)
    expect(s.p.info(s.room.id)).toMatchObject({ convId: 'a', kind: 'web', url: URL, title: 'Carrinho', project: 'alpha' })
    // Sem chamada nova: a TV apaga.
    expect(s.tick(PROJECTOR_IDLE_MS - 1_000)).toBe(false)
    expect(s.tick(2_000)).toBe(true)
    s.run(4)
    expect([fx.drop, fx.lit]).toEqual([0, 0])
    expect(keysOf(s.p)).toEqual([])
    s.p.dispose()
  })

  it('sala de reunião fora da tela vai direto para o fim (sem animar); no escuro (apagão) a TV não acende', () => {
    const s = setup()
    s.tvLod.culled = true
    s.feed()
    expect(s.run(0.1)).toBe(0)
    const fx = s.p.room(s.room.id)!
    expect([fx.drop, fx.lit]).toEqual([1, 1])
    s.tvLod.culled = false
    s.setDark(true)
    s.run(2)
    expect([fx.drop, fx.lit]).toEqual([1, 0])
    s.setDark(false)
    s.run(2)
    expect(fx.lit).toBe(1)
    s.p.dispose()
  })

  it('sem tela retrátil nem projetor de teto: só a imagem na TV, acesa em qualquer distância', () => {
    const s = setup()
    s.feed()
    s.run(4)
    const root = s.view.group.getObjectByName('tv-image')!
    expect(s.view.group.getObjectByName('projector')).toBeUndefined()
    const visible = (): boolean[] => {
      const out: boolean[] = []
      root.traverse((o) => o.type === 'Mesh' && out.push(o.visible))
      return out
    }
    s.tvLod.level = 2
    s.run(0.1)
    expect(visible()).toEqual([true])
    s.tvLod.level = 0
    s.run(0.1)
    expect(visible()).toEqual([true])
    s.p.dispose()
  })
})

describe('Projectors: os quadros do navegador', () => {
  function bitmaps() {
    const made: Array<{ close: ReturnType<typeof vi.fn> }> = []
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      const b = { width: 960, height: 540, close: vi.fn() }
      made.push(b)
      return b as unknown as ImageBitmap
    }))
    return made
  }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  it(`decodifica só com a tela acesa e no máximo a cada ${MIN_PAINT_MS} ms; o bitmap velho fecha na hora; dispose fecha o último e tira os ouvintes`, async () => {
    const made = bitmaps()
    const api = fakeBrowserApi()
    const s = setup()
    s.p.connect(api, () => 'a', () => false)
    expect(api.listeners()).toBe(2)
    s.feed()
    api.frame(jpegFrame(btoa('q1')))
    expect(made).toHaveLength(0) // ainda apagada: nada decodifica
    s.run(4)
    await flush()
    expect(made).toHaveLength(1) // acendeu: o quadro guardado aparece
    api.frame(jpegFrame(btoa('q2')))
    await flush()
    expect(made).toHaveLength(1) // dentro do intervalo
    s.tick(MIN_PAINT_MS + 50)
    await flush()
    expect(made).toHaveLength(2)
    expect(made[0].close).toHaveBeenCalledTimes(1)
    expect(made[1].close).not.toHaveBeenCalled()
    expect(s.p.info(s.room.id)?.live).toBe(true)
    s.p.dispose()
    expect(made[1].close).toHaveBeenCalledTimes(1)
    expect(api.listeners()).toBe(0)
  })

  it('a tela acesa desenha a página: o quadro real, a página falsa na demo ou o esqueleto com URL e título', () => {
    const paint = vi.spyOn(RoomProjector.prototype, 'paint')
    const demo = setup(testing('demo-1-0'))
    demo.p.demo = true
    demo.feed()
    demo.run(4)
    const view = paint.mock.calls.at(-1)![0]
    expect(view).toMatchObject({ kind: 'web', url: URL, title: 'Carrinho', live: true })
    expect(view.image).not.toBeNull()
    demo.p.dispose()
    paint.mockClear()
    const plain = setup()
    plain.feed()
    plain.run(4)
    expect(paint.mock.calls.at(-1)![0]).toMatchObject({ url: URL, live: false, image: null })
    plain.p.dispose()
  })

  it('dispose libera a textura e o material da imagem da TV', () => {
    const s = setup()
    s.feed()
    s.run(4)
    const root = s.view.group.getObjectByName('tv-image')!
    const own = new Set<Material | Texture>()
    root.traverse((o) => {
      const m = (o as { material?: Material & { map?: Texture | null } }).material
      if (m && (m.transparent || m.map)) own.add(m)
      if (m?.map) own.add(m.map)
    })
    const freed = new Set<unknown>()
    for (const r of own) r.addEventListener('dispose', () => freed.add(r))
    s.p.dispose()
    expect(own.size).toBeGreaterThanOrEqual(2)
    expect(freed.size).toBe(own.size)
    expect(s.view.group.getObjectByName('tv-image')).toBeUndefined()
  })
})

describe('OfficeScene com a TV', () => {
  it('quando a TV acende, só quem está perto dela olha para ela', () => {
    const glance = vi.spyOn(Character3D.prototype, 'glance')
    const f = testing()
    const model = deriveOfficeModel(f, NOW)
    const scene = new OfficeScene()
    scene.sync(layoutOffice(model), f, { snapshot: snapshotOf(f, model, NOW), events: [], wallNow: NOW, t: 0 })
    // Longe da TV (na mesa da ilha da frente): não olha.
    for (let i = 0; i < 40; i++) scene.animate(i * 0.1, 0.1)
    expect(glance).not.toHaveBeenCalled()
    // Perto da TV quando ela acende de novo: olha.
    const b = scene.crowd.list[0]
    const tv = scene.tvCenter()
    Object.assign(b, { x: tv.x - 1, z: tv.z + 2.5 })
    scene.projectors.room(OFFICE_ID)!.onLit()
    expect(glance).toHaveBeenCalledTimes(1)
    const [, y] = glance.mock.calls[0]
    expect(y).toBeCloseTo(IMG_Y)
    scene.dispose()
  })
})
