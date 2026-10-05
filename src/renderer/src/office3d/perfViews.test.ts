import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DirectionalLight,
  Fog,
  Frustum,
  InstancedMesh,
  Matrix4,
  Mesh,
  Sprite,
  type BufferGeometry,
  type Camera,
  type Material,
  type Object3D,
  type Scene
} from 'three'
import { isCentralConversation } from '@shared/central'
import { demoFeed } from './demoFeed'
import { DEMO_PLAN_ID } from './demoPlan'
import { DEMO_LOOP_MS } from './demoTimeline'
import { Office3DEngine, type RendererLike } from './engine'
import { FAR_PIXEL_SCALE } from './lod'

/**
 * Desempenho medido no grafo de cena (jsdom não tem WebGL): com a demo de
 * 5 projetos × 4 agentes, em 3 vistas, conta o que o three desenharia — objetos
 * visíveis dentro do frustum da câmera, chamadas de desenho e triângulos do
 * passo principal e do passo de sombra. O renderer stub preenche
 * renderer.info com essa contagem (o que o HUD de DEV mostra) e imita o
 * shadowMap sob demanda (needsUpdate só zera quando o sol projeta).
 */

const T0 = 14_916_667 * DEMO_LOOP_MS
/**
 * Medido na versão anterior (uma sala por projeto, commit 4c819a6), com a mesma demo e o mesmo
 * número de agentes, passo principal + sombra: PERTO de uma sala, o prédio inteiro e o LONGE.
 * O escritório único não pode desenhar mais que isso (PERTO aqui = de perto de uma ilha).
 */
const BEFORE = {
  perto: { calls: 210 + 92, triangles: 7_156 + 6_680 },
  predio: { calls: 770 + 120, triangles: 29_070 + 5_720 },
  longe: { calls: 495, triangles: 20_954 }
}
/** O mesmo, no apagão com festa (versão anterior). */
const BEFORE_PARTY = {
  perto: { calls: 239 + 92, triangles: 8_719 + 6_680 },
  predio: { calls: 844 + 120, triangles: 31_629 + 5_720 },
  longe: { calls: 514, triangles: 21_410 }
}

/**
 * Triângulos (principal + sombra), a linha de base dos agentes de ~1,80 m (bodyGeo.ts) e da cadeira
 * igual à do mockup (chairModel.ts, ~2 mil triângulos cada, 25 cadeiras) com ~15% de folga: o corpo e a cadeira têm mais triângulos, as chamadas
 * continuam abaixo de BEFORE/BEFORE_PARTY.
 */
const TRIS = { perto: 112_000, predio: 150_000, longe: 72_000 }

interface PassStats {
  objects: number
  calls: number
  triangles: number
}

function trianglesOf(geo: BufferGeometry): number {
  const n = geo.index ? geo.index.count : geo.attributes.position.count
  return Math.floor(Math.min(n, geo.drawRange.count) / 3)
}

function chainVisible(o: Object3D): boolean {
  for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false
  return true
}

const materialVisible = (m: Material | Material[]): boolean => (Array.isArray(m) ? m.some((x) => x.visible) : m.visible)

/** O que o three mandaria para a GPU vendo `root` por `camera` (ou, com `casters`, o passo de sombra). */
function passStats(root: Object3D, camera: Camera, casters = false): PassStats {
  root.updateMatrixWorld(true)
  camera.updateMatrixWorld()
  const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
  const out: PassStats = { objects: 0, calls: 0, triangles: 0 }
  root.traverse((o) => {
    if (o instanceof Sprite) {
      if (casters || !chainVisible(o) || !o.material.visible) return
      if (o.frustumCulled && !frustum.intersectsSprite(o)) return
      out.objects++
      out.calls++
      out.triangles += 2
      return
    }
    if (!(o instanceof Mesh)) return
    if (!chainVisible(o) || !materialVisible(o.material)) return
    if (casters && !o.castShadow) return
    const count = o instanceof InstancedMesh ? o.count : 1
    if (count === 0) return
    if (o.frustumCulled && !frustum.intersectsObject(o)) return
    out.objects++
    out.calls++
    out.triangles += trianglesOf(o.geometry) * count
  })
  return out
}

const sunOf = (scene: Object3D): DirectionalLight | undefined => scene.children.find((o): o is DirectionalLight => o instanceof DirectionalLight)

/** Passo de sombra: só se o sol projeta sombra. */
function shadowStats(scene: Scene): PassStats {
  const sun = sunOf(scene)
  if (!sun?.castShadow) return { objects: 0, calls: 0, triangles: 0 }
  scene.updateMatrixWorld(true)
  sun.shadow.updateMatrices(sun)
  return passStats(scene, sun.shadow.camera, true)
}

/** Renderer stub que conta como o three: info.render = principal (+ sombra no quadro em que ela é refeita). */
function countingRenderer() {
  const r = {
    ratio: 0,
    renders: 0,
    shadowPasses: 0,
    shadowMap: { autoUpdate: false, needsUpdate: false },
    info: { render: { calls: 0, triangles: 0 } },
    setPixelRatio(v: number) {
      r.ratio = v
    },
    setSize() {},
    render(scene: Scene, camera: Camera) {
      r.renders++
      const main = passStats(scene, camera)
      let { calls, triangles } = main
      if (r.shadowMap.needsUpdate && sunOf(scene)?.castShadow) {
        const s = shadowStats(scene)
        calls += s.calls
        triangles += s.triangles
        r.shadowPasses++
        r.shadowMap.needsUpdate = false
      }
      r.info.render.calls = calls
      r.info.render.triangles = triangles
    },
    dispose() {}
  }
  return r satisfies RendererLike
}

function demoEngine(renderer: RendererLike = countingRenderer()) {
  const container = document.createElement('div')
  Object.defineProperty(container, 'clientWidth', { get: () => 1600 })
  Object.defineProperty(container, 'clientHeight', { get: () => 900 })
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  // "Draw calls iguais ou melhores que hoje com o MESMO número de agentes": sem a Central nem o Manager (o escritório de antes não os tinha).
  const demo = demoFeed(Date.now())
  const feed = { ...demo, conversations: demo.conversations.filter((c) => !isCentralConversation(c) && c.id !== DEMO_PLAN_ID) }
  let t = 0
  const queue: FrameRequestCallback[] = []
  const engine = new Office3DEngine(container, canvas, { onFocus: vi.fn(), onOpen: vi.fn() }, {
    createRenderer: () => renderer,
    raf: (cb) => queue.push(cb),
    caf: () => {},
    now: () => t,
    source: { getSnapshot: () => feed, subscribe: () => () => {} }
  })
  const flush = (n: number): void => {
    for (let i = 0; i < n; i++) {
      t += 16
      for (const cb of queue.splice(0)) cb(t)
    }
  }
  return { engine, flush, container, pending: () => queue.length }
}

/** Malhas marcadas `tag` ainda visíveis (a cadeia inteira). */
function visibleTagged(scene: Scene, tag: 'detail' | 'small'): number {
  let n = 0
  scene.traverse((o) => {
    if (o.userData.lod === tag && chainVisible(o)) n++
  })
  return n
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  }
  vi.useFakeTimers({ toFake: ['Date'], now: T0 + 20_000 })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** De perto de uma ilha (o tamanho de uma sala de antes). */
const NEAR_ISLAND = { tx: -4.25, ty: 0, tz: 6.46, yaw: 0, pitch: 0.9, distance: 6 }

describe('desempenho nas 3 vistas (demo 5 projetos × 4 agentes)', () => {
  it('culling por zona, LOD por distância, sombra sob demanda e ~30 fps no LONGE — números em renderer.info', () => {
    const renderer = countingRenderer()
    const { engine, flush } = demoEngine(renderer)
    flush(30)
    const building = { ...engine.rig.pose }
    engine.rig.zoom(1e5)
    const longe = { ...engine.rig.pose }
    const views = {
      perto: NEAR_ISLAND,
      predio: building,
      longe
    }
    const rows: Record<string, Record<string, number | string>> = {}
    const scene = engine.scene.scene
    for (const [name, pose] of Object.entries(views) as Array<[keyof typeof views, typeof building]>) {
      engine.rig.pose = { ...pose }
      engine.requestRender()
      flush(1)
      const r0 = renderer.renders
      const s0 = renderer.shadowPasses
      flush(60)
      const main = passStats(scene, engine.camera)
      const shadow = shadowStats(scene)
      const s = engine.stats
      rows[name] = {
        salas: `${s.rooms}/${s.roomsTotal}`,
        lod: s.lod,
        pixelRatio: s.pixelRatio,
        objetos: main.objects,
        calls: main.calls,
        tris: main.triangles,
        sombraCalls: shadow.calls,
        sombraTris: shadow.triangles,
        sombraPassos60: renderer.shadowPasses - s0,
        quadros60: renderer.renders - r0,
        total: main.calls + shadow.calls,
        totalTris: main.triangles + shadow.triangles,
        hud: s.calls - renderer.info.render.calls
      }
    }
    console.log(`[perf] distância da câmera: prédio=${building.distance.toFixed(1)} longe=${longe.distance.toFixed(1)}`)
    console.table(rows)
    for (const name of Object.keys(views) as Array<keyof typeof views>) {
      // Pior quadro agora (principal + sombra) contra o da versão anterior.
      expect(Number(rows[name].total), name).toBeLessThanOrEqual(BEFORE[name].calls)
      expect(Number(rows[name].totalTris), name).toBeLessThan(TRIS[name])
      // O HUD lê o renderer.info do último quadro.
      expect(rows[name].hud).toBe(0)
    }

    // PERTO de uma ilha: zonas saem do frustum; tudo completo; resolução cheia.
    expect(rows.perto.lod).toBe(0)
    const [seen, total] = String(rows.perto.salas).split('/').map(Number)
    expect(seen).toBeLessThan(total)
    expect(rows.perto.pixelRatio).toBe(1)
    // Escritório inteiro: todas as zonas, sem detalhe longe; sombra NÃO é refeita todo quadro.
    expect(rows.predio).toMatchObject({ salas: `${total}/${total}`, pixelRatio: 1 })
    expect(rows.predio.sombraPassos60).toBeLessThan(Number(rows.predio.quadros60))
    // Zoom máximo: LONGE — sem sombra, resolução menor, névoa, ~30 fps.
    expect(rows.longe).toMatchObject({ lod: 2, pixelRatio: FAR_PIXEL_SCALE, sombraCalls: 0, sombraPassos60: 0 })
    expect(Number(rows.longe.quadros60)).toBeLessThanOrEqual(31)
    expect(visibleTagged(scene, 'detail') + visibleTagged(scene, 'small')).toBe(0)
    const fog = scene.fog as Fog
    expect(fog.near).toBeLessThan(longe.distance)
    expect(fog.far).toBeGreaterThan(longe.distance)
    engine.dispose()
  })

  it('apagão com festa: mesmas regras (calls < antes, LONGE ~30 fps sem sombra), festa só PERTO/MÉDIO, nada novo na cena por quadro', () => {
    // Aos 60 s do loop a janela de 5h está esgotada: apagão desde o 1º retrato.
    vi.setSystemTime(T0 + 60_000)
    const renderer = countingRenderer()
    const { engine, flush, pending } = demoEngine(renderer)
    expect(engine.officePower?.level).toBe('apagao')
    flush(30)
    const scene = engine.scene.scene
    const building = { ...engine.rig.pose }
    const views = {
      perto: NEAR_ISLAND,
      predio: building,
      longe: { ...building, distance: 60 }
    }
    const count = (): number => {
      let n = 0
      scene.traverse(() => void n++)
      return n
    }
    const partyVisible = (): number => {
      let n = 0
      scene.traverse((o) => {
        if (o.name === 'paper-planes' && (o as InstancedMesh).count > 0) n++
        if ((o as Mesh).renderOrder === 3 && chainVisible(o) && o instanceof InstancedMesh) n++
      })
      return n
    }
    const rows: Record<string, Record<string, number | string>> = {}
    for (const [name, pose] of Object.entries(views) as Array<[keyof typeof views, typeof building]>) {
      engine.rig.pose = { ...pose }
      engine.requestRender()
      flush(30)
      const before = count()
      const r0 = renderer.renders
      flush(60)
      const main = passStats(scene, engine.camera)
      const shadow = shadowStats(scene)
      rows[name] = { salas: `${engine.stats.rooms}/${engine.stats.roomsTotal}`, lod: engine.stats.lod, calls: main.calls, tris: main.triangles, sombraCalls: shadow.calls, festa: partyVisible(), quadros60: renderer.renders - r0 }
      expect(main.calls + shadow.calls, name).toBeLessThanOrEqual(BEFORE_PARTY[name].calls)
      expect(main.triangles + shadow.triangles, name).toBeLessThan(TRIS[name])
      // Nenhum objeto novo entra na cena quadro a quadro (pools e malhas criadas uma vez).
      expect(count()).toBe(before)
    }
    console.table(rows)
    expect(Number(rows.perto.festa)).toBeGreaterThan(0)
    expect(rows.longe).toMatchObject({ lod: 2, sombraCalls: 0, festa: 0 })
    expect(Number(rows.longe.quadros60)).toBeLessThanOrEqual(31)
    // Câmera longe do prédio: o laço para (render sob demanda), mesmo no apagão.
    engine.rig.pose = { ...building, tx: building.tx + 400, tz: building.tz + 400, distance: 10 }
    engine.requestRender()
    flush(5)
    expect(engine.stats.rooms).toBe(0)
    expect(pending()).toBe(0)
    engine.dispose()
  })
})
