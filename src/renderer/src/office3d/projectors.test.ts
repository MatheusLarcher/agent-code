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
import { HTML_SHOW_MS } from './agentHtml'
import { callMarks } from './officeCalls'
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

describe('A TV da sala de reunião: sempre ligada; o teste ao vivo entra e sai', () => {
  it('nasce acesa e clicável (o placar), sem animar; o teste ao vivo entra; depois de PROJECTOR_IDLE_MS volta o placar', () => {
    const paint = vi.spyOn(RoomProjector.prototype, 'paint')
    const s = setup()
    const fx = s.p.room(s.room.id)!
    expect([fx.drop, fx.lit]).toEqual([1, 1])
    expect(keysOf(s.p)).toContain(`${PROJECTOR_KEY}${s.room.id}`)
    expect(s.run(1)).toBe(0)
    s.feed()
    expect(s.p.isDown(s.room.id)).toBe(true)
    s.run(1)
    expect(paint.mock.calls.at(-1)![0]).toMatchObject({ kind: 'web', url: URL, title: 'Carrinho', project: 'alpha' })
    expect(s.p.focusInfo()).toMatchObject({ kind: 'test', convId: 'a', url: URL, title: 'Carrinho', waiting: 0 })
    // Parada e acesa: nada anima (render sob demanda).
    expect(s.run(1)).toBe(0)
    // Sem chamada nova: o teste sai e volta o placar (a TV continua acesa).
    expect(s.tick(PROJECTOR_IDLE_MS - 1_000)).toBe(false)
    expect(s.tick(2_000)).toBe(true)
    expect(s.p.isDown(s.room.id)).toBe(false)
    expect(paint.mock.calls.at(-1)![0].score).toMatchObject({ project: null, todo: 0, doing: 0, done: 0 })
    expect(paint.mock.calls.at(-1)![0].score!.working).toHaveLength(1) // a conversa ocupada
    expect(s.p.focusInfo()).toMatchObject({ kind: 'score' })
    expect([fx.drop, fx.lit]).toEqual([1, 1])
    s.p.dispose()
  })

  it('sala de reunião fora da tela vai direto para o fim (sem animar); no escuro (apagão) a TV apaga e, na volta, acende avisando o centro da TV', () => {
    const s = setup()
    const lit = vi.fn()
    s.p.onLit = lit
    s.tvLod.culled = true
    s.feed()
    expect(s.run(0.1)).toBe(0)
    const fx = s.p.room(s.room.id)!
    expect([fx.drop, fx.lit]).toEqual([1, 1])
    s.tvLod.culled = false
    s.setDark(true)
    s.run(2)
    expect([fx.drop, fx.lit]).toEqual([1, 0])
    expect(keysOf(s.p)).toEqual([])
    s.setDark(false)
    s.run(2)
    expect(fx.lit).toBe(1)
    expect(lit).toHaveBeenCalledTimes(1)
    const [id, x, y, z] = lit.mock.calls[0]
    expect([id, x, y]).toEqual([OFFICE_ID, MEETING.tv.x, IMG_Y])
    expect(z).toBeCloseTo(s.view.furniture.tv.z)
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
    const paint = vi.spyOn(RoomProjector.prototype, 'paint')
    const api = fakeBrowserApi()
    const s = setup()
    s.p.connect(api, () => 'a', () => false)
    expect(api.listeners()).toBe(2)
    s.setDark(true)
    s.run(2)
    s.feed()
    api.frame(jpegFrame(btoa('q1')))
    expect(made).toHaveLength(0) // apagada (sem energia): nada decodifica
    s.setDark(false)
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
    expect(paint.mock.calls.at(-1)![0].live).toBe(true)
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

describe('A TV mostra o HTML que o agente criou (sem teste ao vivo)', () => {
  const PATH = 'C:\\proj\\alpha\\mockups\\tela.html'
  const write = (id: string, path = PATH): UIMessage => ({ kind: 'tool-use', id, name: 'Write', input: { file_path: path, content: '<h1>' }, parentToolUseId: null, result: { isError: false, text: 'ok' } })
  const withMsgs = (messages: UIMessage[]) => feed({ conversations: [conv('a', { messages, updatedAt: NOW })], busyIds: new Set(['a']), activeId: 'a' })
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }

  it('o histórico não entra; HTML novo entra com o esqueleto, pede a captura e desenha o bitmap; o teste ao vivo passa na frente; some depois de HTML_SHOW_MS (volta o placar)', async () => {
    const bitmap = { width: 1280, height: 640, close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap as unknown as ImageBitmap))
    const capture = vi.fn(async () => ({ ok: true as const, url: 'agent-mockup://t/mockups/tela.html', png: new Uint8Array([1]) }))
    vi.stubGlobal('api', { officeMockupCapture: capture })
    const paint = vi.spyOn(RoomProjector.prototype, 'paint')
    const s = setup(withMsgs([write('old')]))
    s.feed()
    expect(s.p.agendaOf(OFFICE_ID)!.main.kind).toBe('score') // histórico do 1º feed
    s.feed(withMsgs([write('old'), write('w1')]))
    expect(s.p.agendaOf(OFFICE_ID)!.main.kind).toBe('html')
    expect(capture).toHaveBeenCalledWith({ cwd: 'C:\\proj\\alpha', path: PATH })
    s.run(4)
    expect(paint.mock.calls.at(-1)![0]).toMatchObject({ kind: 'web', url: 'mockups/tela.html', title: 'tela.html', live: false })
    await flush()
    expect(paint.mock.calls.at(-1)![0].image).not.toBeNull()
    // O teste ao vivo tem prioridade sobre o HTML; o bitmap do HTML fecha.
    s.feed(withMsgs([write('old'), write('w1'), ...MSGS]))
    s.run(1)
    expect(paint.mock.calls.at(-1)![0]).toMatchObject({ url: URL })
    expect(bitmap.close).toHaveBeenCalledTimes(1)
    // Fim do teste: volta o HTML (ainda dentro de HTML_SHOW_MS); depois some e a TV apaga.
    s.tick(PROJECTOR_IDLE_MS + 1)
    expect(s.p.agendaOf(OFFICE_ID)!.main.kind).toBe('html')
    s.tick(HTML_SHOW_MS)
    expect(s.p.agendaOf(OFFICE_ID)!.main.kind).toBe('score')
    s.p.dispose()
  })

  it('captura que falha (ou fora do app) deixa o esqueleto com o nome do arquivo', async () => {
    vi.stubGlobal('api', { officeMockupCapture: vi.fn(async () => ({ ok: false as const, error: 'tempo esgotado' })) })
    const paint = vi.spyOn(RoomProjector.prototype, 'paint')
    const s = setup(withMsgs([]))
    s.feed()
    s.feed(withMsgs([write('w1')]))
    s.run(4)
    await flush()
    s.tick(MIN_PAINT_MS + 1)
    expect(paint.mock.calls.at(-1)![0]).toMatchObject({ url: 'mockups/tela.html', title: 'tela.html', image: null })
    s.p.dispose()
  })
})

describe('A fila da sala: os chamados antes de quem testa', () => {
  it('quem chamou vem primeiro (marcado como chamado); quem testa depois; a marca de aberto tira o chamado no tique', () => {
    const called: UIMessage[] = [
      { kind: 'user', id: 'u1', text: 'faz a tela' },
      { kind: 'tool-use', id: 'call-q1', name: 'mcp__app__app_chamar_usuario', input: { arquivo: 'tela.html' }, parentToolUseId: null, result: { isError: false, text: 'ok' } }
    ]
    const f = feed({ conversations: [conv('a', { messages: called, updatedAt: NOW }), conv('b', { messages: MSGS, updatedAt: NOW })], busyIds: new Set(['b']), activeId: 'b' })
    const s = setup(f)
    const rooms: unknown[] = []
    s.p.onRoom = (order) => rooms.push(order)
    s.feed()
    expect(rooms.at(-1)).toEqual([{ key: 'conv:a', call: true }, 'conv:b'])
    expect(s.p.openCalls().map((c) => c.id)).toEqual(['call-q1'])
    callMarks.end('call-q1', 'aberto')
    s.tick(100)
    expect(rooms.at(-1)).toEqual(['conv:b'])
    s.p.dispose()
  })
})

describe('A TV com o planejamento', () => {
  it('sem chamado nem teste, a TV pinta o resumo do plano (lido do main, sem vigia); o foco abre o plano com as abas', async () => {
    const peek = vi.fn(async () => ({ ok: true as const, plan: { titulo: 'Checkout novo', etapas: [{ titulo: 'Cenário', status: 'concluida' as const }, { titulo: 'Pagamento', status: 'em_andamento' as const }], cards: 9, ambiguidadesAbertas: 1 } }))
    vi.stubGlobal('api', { planningPeek: peek })
    const paint = vi.spyOn(RoomProjector.prototype, 'paint')
    const f = feed({ conversations: [conv('p', { mode: 'planning', planningSlug: 'checkout', title: 'Plano do checkout', updatedAt: NOW })], activeId: 'p' })
    const s = setup(f)
    s.feed()
    s.run(1)
    expect(peek).toHaveBeenCalledWith({ projectCwd: 'C:\\proj\\alpha', slug: 'checkout' })
    for (let i = 0; i < 4; i++) await Promise.resolve()
    s.tick(MIN_PAINT_MS + 1)
    expect(paint.mock.calls.at(-1)![0].plan).toMatchObject({ manager: 'Plano do checkout', titulo: 'Checkout novo', cards: 9, ambiguidades: 1 })
    expect(s.p.focusInfo()).toMatchObject({ kind: 'plan', convId: 'p', plans: [{ convId: 'p', title: 'Plano do checkout' }] })
    s.p.dispose()
  })
})

describe('A TV com chamado: prioridade, quadrinho, fila e foco', () => {
  const calling = (id: string, callId: string): ReturnType<typeof conv> =>
    conv(id, {
      updatedAt: NOW,
      messages: [
        { kind: 'user', id: `u-${id}`, text: 'faz' },
        { kind: 'tool-use', id: callId, name: 'mcp__app__app_chamar_usuario', input: { arquivo: `${id}.html`, mensagem: 'Olha!' }, parentToolUseId: null, result: { isError: false, text: 'ok' } }
      ]
    })

  it('o mockup de quem chama manda na TV, com a faixa; o teste vai para o quadrinho; "+1 esperando"; com o foco a TV congela; o filtro tira o que é de outro projeto', () => {
    const paint = vi.spyOn(RoomProjector.prototype, 'paint')
    const f = feed({ conversations: [calling('c', 'q-c'), calling('d', 'q-d'), conv('b', { messages: MSGS, updatedAt: NOW })], busyIds: new Set(['b']), activeId: 'b' })
    const s = setup(f)
    s.feed()
    s.run(1)
    const v = paint.mock.calls.at(-1)![0]
    expect(v).toMatchObject({ url: 'c.html', title: 'c.html', banner: { text: 'Olha!' }, pip: { url: URL }, waiting: 1 })
    expect(v.banner!.title).toContain('está te chamando')
    expect(s.p.focusInfo()).toMatchObject({ kind: 'mockup', convId: 'c', rel: 'c.html', callId: 'q-c', waiting: 1 })
    // Foco na TV: o chamado de c acaba, mas a tela fica como estava até sair do foco.
    s.p.lock(true)
    callMarks.end('q-c', 'aberto')
    s.tick(100)
    expect(s.p.agendaOf(OFFICE_ID)!.main).toMatchObject({ kind: 'call', call: { id: 'q-c' } })
    s.p.lock(false)
    expect(s.p.agendaOf(OFFICE_ID)!.main).toMatchObject({ kind: 'call', call: { id: 'q-d' } })
    // Filtro em outro projeto: nada dele na TV (o placar).
    s.p.content.filter = 'outro'
    s.tick(200)
    expect(s.p.agendaOf(OFFICE_ID)!.main.kind).toBe('score')
    s.p.dispose()
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
    const tv = scene.projectors.screen()!
    Object.assign(b, { x: tv.x - 1, z: tv.z + 2.5 })
    scene.projectors.room(OFFICE_ID)!.onLit()
    expect(glance).toHaveBeenCalledTimes(1)
    const [, y] = glance.mock.calls[0]
    expect(y).toBeCloseTo(IMG_Y)
    scene.dispose()
  })
})
