import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { Group, InstancedMesh, Matrix4, PerspectiveCamera, Raycaster, Vector3 } from 'three'
import { deriveOfficeModel } from '../office/adapter/model'
import { conv, feed } from '../office/adapter/testFeed'
import type { OfficeFeed } from '../office/adapter/feed'
import type { UIMessage } from '../types'
import type { Character3D } from './characters'
import type { RoomView } from './decor'
import { demoFeed } from './demoFeed'
import { DEMO_LOOP_MS } from './demoTimeline'
import { Office3DEngine, type RendererLike } from './engine'
import { MEMORY_PAPERS_KEY } from './engineTypes'
import { createKit } from './kit'
import { layoutOffice } from './layout'
import { createMemoryPapers, MAX_SHEETS, MEMORY_PAPERS_AT, memoryReadsOf } from './memoryPapers'
import { deskMemoryReads } from './memoryUsage'
import { deskPoint } from './officePlan'
import { OfficeScene } from './scene'

const T0 = 14_916_667 * DEMO_LOOP_MS
const MEM = 'D:\\dados\\memories'
const tool = (id: string, name: string, input: unknown, isError = false): UIMessage => ({ kind: 'tool-use', id, name, input, parentToolUseId: null, result: { isError, text: 'ok' } }) as UIMessage
const read = (id: string, rel: string, isError = false): UIMessage => tool(id, 'Read', { file_path: `${MEM}\\${rel.replace(/\//g, '\\')}` }, isError)
/** As leituras de memória de um agente: duas distintas, uma repetida, uma com erro. */
const reads = (p: string): UIMessage[] => [read(`${p}1`, '2D/vps.md'), read(`${p}2`, 'raiz.md'), read(`${p}3`, '2D/vps.md'), read(`${p}4`, 'falhou.md', true)]

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('as memórias que o agente leu (deskMemoryReads)', () => {
  it('relPaths distintos na ordem da 1ª leitura: só Read na pasta, sem erro; lista, gravação, índice e fora da pasta não contam', () => {
    const c = conv('a', {
      messages: [
        tool('l', 'mcp__memory__memory_list', {}),
        read('r1', '2D/vps.md'),
        tool('p', 'mcp__memory__memory_propose', { op: 'create', rel_path: 'nova.md' }),
        read('r2', 'raiz.md'),
        read('r3', '2D/vps.md'),
        read('r4', 'falhou.md', true),
        read('r5', 'MEMORY.md'),
        tool('o', 'Read', { file_path: 'C:\\proj\\a.ts' }),
        tool('s', 'mcp__memory__memory_status', {})
      ]
    })
    expect(deskMemoryReads(c, MEM)).toEqual(['2D/vps.md', 'raiz.md'])
    expect(deskMemoryReads(c, null)).toEqual([])
  })

  it('memoryReadsOf: pela conversa do feed, guardado enquanto o array de mensagens não muda', () => {
    const c = conv('a', { messages: reads('a') })
    const f = feed({ conversations: [c] })
    const first = memoryReadsOf(f, 'a', MEM)
    expect(first).toEqual(['2D/vps.md', 'raiz.md'])
    expect(memoryReadsOf(f, 'a', MEM)).toBe(first)
    expect(memoryReadsOf(f, 'b', MEM)).toEqual([])
    expect(memoryReadsOf(f, 'a', null)).toEqual([])
    expect(memoryReadsOf(null, 'a', MEM)).toEqual([])
    const more = feed({ conversations: [{ ...c, messages: [...c.messages, read('x', 'outra.md')] }] })
    expect(memoryReadsOf(more, 'a', MEM)).toEqual(['2D/vps.md', 'raiz.md', 'outra.md'])
  })
})

describe('a pilha de papéis de memória na mesa (createMemoryPapers)', () => {
  it('uma folha por memória com teto, só refaz quando muda, no lado livre da mesa; alvo de clique só com folha', () => {
    const kit = createKit(1)
    const g = new Group()
    const papers = createMemoryPapers(kit, { desks: [{ x: 0, z: 0, yaw: 0 }, { x: 4, z: 0, yaw: Math.PI }] }, g)
    expect(papers.mesh.name).toBe('memory-papers')
    expect(papers.mesh.userData.lod).toBe('small')
    expect(papers.mesh.count).toBe(0)
    const v0 = papers.mesh.instanceMatrix.version
    papers.set(0, 3, 'conv:a')
    expect(papers.mesh.count).toBe(3)
    const v1 = papers.mesh.instanceMatrix.version
    expect(v1).toBeGreaterThan(v0)
    papers.set(0, 3, 'conv:a')
    expect(papers.mesh.instanceMatrix.version).toBe(v1)
    papers.set(1, 50, 'conv:b')
    expect(papers.sheets(1)).toBe(MAX_SHEETS)
    expect(papers.mesh.count).toBe(3 + MAX_SHEETS)
    // Sem dono, nenhuma folha.
    papers.set(1, 5, null)
    expect(papers.sheets(1)).toBe(0)

    // As folhas da mesa 0 (yaw 0, na origem): à direita do mouse (x 0,36), antes da borda (0,775), na frente do
    // fichário/caneca (z ≤ 0,055) e atrás da plaquinha (z 0,42) — nada da pilha de contexto (x < 0).
    const m = new Matrix4()
    const c = new Vector3()
    for (let i = 0; i < 3; i++) {
      papers.mesh.getMatrixAt(i, m)
      for (const [sx, sz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
        c.set(sx, 0, sz).applyMatrix4(m)
        expect(c.x).toBeGreaterThan(0.36)
        expect(c.x).toBeLessThan(0.775)
        expect(c.z).toBeGreaterThan(0.06)
        expect(c.z).toBeLessThan(0.4)
      }
      expect(m.determinant()).not.toBe(0)
    }

    // O raio de cima pega o alvo da mesa com folha; o da mesa sem folha fica fora do raio.
    const ray = new Raycaster()
    g.updateMatrixWorld(true)
    const down = new Vector3(0, -1, 0)
    ray.set(new Vector3(MEMORY_PAPERS_AT.lx, 3, MEMORY_PAPERS_AT.lz), down)
    expect(ray.intersectObjects([...papers.picks]).map((h) => h.object.userData.charKey)).toEqual([`${MEMORY_PAPERS_KEY}conv:a`])
    const p1 = deskPoint({ x: 4, z: 0, yaw: Math.PI }, MEMORY_PAPERS_AT.lx, MEMORY_PAPERS_AT.lz)
    ray.set(new Vector3(p1.x, 3, p1.z), down)
    expect(ray.intersectObjects([...papers.picks])).toHaveLength(0)
    papers.set(0, 0, 'conv:a')
    ray.set(new Vector3(MEMORY_PAPERS_AT.lx, 3, MEMORY_PAPERS_AT.lz), down)
    expect(ray.intersectObjects([...papers.picks])).toHaveLength(0)
    kit.dispose()
  })
})

describe('os papéis de memória na cena (OfficeScene)', () => {
  it('no sync do feed, cada mesa ganha uma folha por memória que o dono leu (a pasta chega depois e refaz); o clique devolve memory-papers:<dono>', async () => {
    vi.stubGlobal('api', { getCacheInfo: vi.fn(async () => ({ memoriesDir: MEM })) })
    const now = T0 + 60_000
    const base = demoFeed(now)
    const f: OfficeFeed = { ...base, conversations: base.conversations.map((c) => ({ ...c, messages: [...c.messages, ...reads(c.id)] })) }
    const layout = layoutOffice(deriveOfficeModel(f, now))
    const s = new OfficeScene()
    const dirty = vi.fn()
    s.onDirty = dirty
    s.sync(layout, f)
    const r = layout.rooms[0]
    const v = (s as unknown as { rooms: Map<string, RoomView> }).rooms.get(r.id)!
    // Antes da pasta: nada na mesa.
    expect(r.desks.every((_, i) => v.memos.sheets(i) === 0)).toBe(true)
    await vi.waitFor(() => expect(s.errands.memoriesDir).toBe(MEM))
    expect(dirty).toHaveBeenCalled()
    let owned = 0
    r.desks.forEach((d, i) => {
      const owner = layout.characters.find((c) => c.key === d.ownerKey)
      expect(v.memos.sheets(i)).toBe(owner ? 2 : 0)
      if (owner) owned++
    })
    expect(owned).toBeGreaterThan(0)
    const meshes = v.zones.flatMap((z) => z.group.children.filter((o): o is InstancedMesh => o instanceof InstancedMesh && o.name === 'memory-papers'))
    expect(meshes).toHaveLength(4)
    expect(meshes.reduce((n, m) => n + m.count, 0)).toBe(owned * 2)

    // O clique de cima da pilha (sem personagem no caminho) devolve a chave da mesa; sem folha, não.
    for (const c of (s as unknown as { charList: Character3D[] }).charList) c.group.visible = false
    const i = r.desks.findIndex((d) => d.ownerKey)
    const desk = r.desks[i]
    const p = deskPoint(desk, MEMORY_PAPERS_AT.lx, MEMORY_PAPERS_AT.lz)
    const cam = new PerspectiveCamera(20, 1, 0.05, 50)
    cam.position.set(p.x + 0.001, 3, p.z)
    cam.lookAt(p.x, 0, p.z)
    cam.updateMatrixWorld(true)
    s.scene.updateMatrixWorld(true)
    expect(s.pick(0, 0, cam)).toBe(`${MEMORY_PAPERS_KEY}${desk.ownerKey}`)
    v.memos.set(i, 0, desk.ownerKey ?? null)
    expect(s.pick(0, 0, cam) ?? '').not.toContain(MEMORY_PAPERS_KEY)
    s.dispose()
  })
})

describe('o clique nos papéis no motor', () => {
  it('chama onMemoryPapers com o dono, sem foco nem voo; o clique no agente continua focando', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(T0 + 30_000)
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    Object.defineProperty(container, 'clientWidth', { get: () => 1600 })
    Object.defineProperty(container, 'clientHeight', { get: () => 900 })
    const canvas = document.createElement('canvas')
    container.appendChild(canvas)
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900, x: 0, y: 0, toJSON: () => ({}) })
    const f = demoFeed(T0 + 30_000)
    const renderer = (): RendererLike => ({ setPixelRatio() {}, setSize() {}, render() {}, dispose() {}, shadowMap: { autoUpdate: false, needsUpdate: false } })
    const onMemoryPapers = vi.fn()
    const onFocus = vi.fn()
    const engine = new Office3DEngine(container, canvas, { onFocus, onOpen: vi.fn(), onMemoryPapers }, { createRenderer: renderer, raf: () => 0, caf: () => {}, now: () => 0, source: { getSnapshot: () => f, subscribe: () => () => {} }, board: null, browser: null })
    const pick = vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(`${MEMORY_PAPERS_KEY}conv:demo-0-0`)
    const click = (): void => {
      fireEvent.pointerDown(canvas, { button: 0, clientX: 300, clientY: 200 })
      fireEvent.pointerUp(window, { button: 0, clientX: 300, clientY: 200 })
    }
    click()
    expect(onMemoryPapers).toHaveBeenCalledWith('conv:demo-0-0')
    expect(engine.focused).toBeNull()
    expect(onFocus).not.toHaveBeenCalled()
    pick.mockReturnValue('conv:demo-0-0')
    click()
    expect(engine.focused).toBe('conv:demo-0-0')
    expect(onMemoryPapers).toHaveBeenCalledTimes(1)
    engine.dispose()
    document.body.innerHTML = ''
    vi.useRealTimers()
  })
})
