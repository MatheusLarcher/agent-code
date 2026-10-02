import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectionalLight, Fog, Mesh, PerspectiveCamera, type Object3D } from 'three'
import { deriveOfficeModel } from '../office/adapter/model'
import { FX } from './brain'
import { cameraPosition, framePose, type CameraPose } from './cameraRig'
import { Character3D } from './characters'
import type { RoomView } from './decor'
import { demoFeed } from './demoFeed'
import { DEMO_LOOP_MS } from './demoTimeline'
import { snapshotOf } from './events'
import { buildingBounds, layoutOffice, type RoomLayout } from './layout'
import { OfficeScene } from './scene'

const T0 = 14_916_667 * DEMO_LOOP_MS
const ASPECT = 16 / 9

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function camera(pose: CameraPose): PerspectiveCamera {
  const cam = new PerspectiveCamera(50, ASPECT, 0.05, 250)
  const p = cameraPosition(pose)
  cam.position.set(p.x, p.y, p.z)
  cam.lookAt(pose.tx, pose.ty, pose.tz)
  cam.updateMatrixWorld()
  return cam
}

function setup(now = T0 + 20_000) {
  const s = new OfficeScene()
  const feed = demoFeed(now)
  const model = deriveOfficeModel(feed, now)
  const layout = layoutOffice(model)
  s.sync(layout, feed, { snapshot: snapshotOf(feed, model, now), events: [], wallNow: now, t: 0 })
  for (let k = 1; k <= 5; k++) s.animate(k / 10, 0.1)
  const internals = s as unknown as { rooms: Map<string, RoomView>; charList: Character3D[] }
  const near = (r: RoomLayout): CameraPose => ({ tx: r.x + r.width / 2, ty: 0, tz: r.z + r.depth / 2, yaw: 0, pitch: 0.8, distance: 9 })
  const building = framePose({ ...buildingBounds(layout.rooms)!, height: 1.8 }, { fovDeg: 50, aspect: ASPECT })
  return { s, layout, feed, rooms: internals.rooms, chars: () => internals.charList, near, building, far: { ...building, distance: 60 } }
}

const chainVisible = (o: Object3D): boolean => {
  for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false
  return true
}

describe('OfficeScene — culling por sala', () => {
  it('sem câmera (nenhum updateView) fica tudo à vista e completo, como antes', () => {
    const { s, rooms, chars } = setup()
    expect([...rooms.values()].every((r) => r.group.visible && r.lod.level === 0)).toBe(true)
    expect(chars().every((c) => !c.culled && c.viewLevel === 0)).toBe(true)
    expect(s.rate).toBe(2)
    s.dispose()
  })

  it('sala fora do frustum: grupo invisível, personagens sem update, tela sem redesenho; a página fica guardada', () => {
    // Aos 30 s do loop o dev de cada sala está trabalhando: toda sala tem tela acesa.
    const { s, layout, rooms, chars, near, feed } = setup(T0 + 30_000)
    const [r0] = layout.rooms
    expect(s.updateView(camera(near(r0)))).toBe(0)
    const culled = layout.rooms.filter((r) => rooms.get(r.id)!.lod.culled)
    expect(culled.length).toBeGreaterThanOrEqual(2)
    expect(rooms.get(r0.id)!.group.visible).toBe(true)
    for (const r of culled) expect(rooms.get(r.id)!.group.visible).toBe(false)
    const out = chars().filter((c) => culled.some((r) => r.id === c.brain.roomId))
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((c) => c.culled && !c.group.visible)).toBe(true)

    const updated = new Set<string>()
    const real = Character3D.prototype.update
    vi.spyOn(Character3D.prototype, 'update').mockImplementation(function (this: Character3D, dt, lod) {
      updated.add(this.key)
      return real.call(this, dt, lod)
    })
    for (let k = 0; k < 10; k++) s.animate(1 + k / 10, 0.1)
    expect(out.some((c) => updated.has(c.key))).toBe(false)
    expect(chars().some((c) => !c.culled && updated.has(c.key))).toBe(true)

    // Feed novo: a sala à vista redesenha; a de fora só guarda a página.
    const lit = culled.flatMap((r) => rooms.get(r.id)!.screens.filter((x) => x.state === 'on'))
    expect(lit.length).toBeGreaterThan(0)
    const draws = lit.map((x) => vi.spyOn(x.on!.mon, 'draw'))
    const seen = rooms.get(r0.id)!.screens.filter((x) => x.on)
    expect(seen.length).toBeGreaterThan(0)
    const seenDraws = seen.map((x) => vi.spyOn(x.on!.mon, 'draw'))
    const now = T0 + 30_000
    const model = deriveOfficeModel(feed, now)
    s.sync(layout, feed, { snapshot: snapshotOf(feed, model, now), events: [], wallNow: now, t: 2 })
    expect(draws.every((d) => d.mock.calls.length === 0)).toBe(true)
    expect(lit.every((x) => x.page !== null)).toBe(true)
    expect(seenDraws.some((d) => d.mock.calls.length > 0)).toBe(true)
    s.dispose()
  })

  it('ao voltar à vista: tela desenha a página guardada, porta já no lugar, sem efeito velho nem partícula', () => {
    const { s, layout, rooms, chars, near } = setup(T0 + 30_000)
    const [r0] = layout.rooms
    s.updateView(camera(near(r0)))
    const r = layout.rooms.find((x) => rooms.get(x.id)!.lod.culled && rooms.get(x.id)!.screens.some((sc) => sc.state === 'on'))!
    const view = rooms.get(r.id)!
    const screen = view.screens.find((sc) => sc.state === 'on')!
    const draw = vi.spyOn(screen.on!.mon, 'draw')
    // Enquanto fora: alguém chega na porta e um agente acumula efeitos.
    const c = chars().find((x) => x.brain.roomId === r.id && x.brain.visible)!
    c.brain.fx = FX.confetti | FX.smoke | FX.sweat
    const walker = chars().find((x) => x.brain.roomId === r.id && x !== c)!.brain
    walker.x = view.doorAt.x + 0.3
    walker.z = view.doorAt.z
    walker.visible = true
    s.animate(2, 0.016)
    expect(view.door.rotation.y).toBe(0)
    expect(s.particles.live).toBe(0)

    s.updateView(camera(near(r)))
    expect(view.lod.culled).toBe(false)
    expect(view.group.visible).toBe(true)
    expect(view.door.rotation.y).toBeCloseTo(1.35)
    expect(draw).toHaveBeenCalledWith(screen.page, screen.accent)
    expect(c.culled).toBe(false)
    s.animate(2.016, 0.016)
    expect(c.brain.fx).toBe(0)
    expect(s.particles.live).toBe(0)
    expect(c.group.visible).toBe(true)
    expect(c.group.position.x).toBeCloseTo(c.brain.x)
    s.dispose()
  })
})

describe('OfficeScene — LOD por distância', () => {
  it('PERTO completo; MÉDIO sem detalhes e tela em meia resolução; LONGE sem pequenos, tela vira bloco na cor do status', () => {
    const { s, layout, rooms, chars, near, building, far } = setup()
    const screens = () => [...rooms.values()].flatMap((r) => r.screens.filter((x) => x.state === 'on'))
    const tagged = (tag: string): Object3D[] => {
      const out: Object3D[] = []
      s.scene.traverse((o) => {
        if (o.userData.lod === tag) out.push(o)
      })
      return out
    }
    const animate = (): void => {
      for (let k = 0; k < 3; k++) s.animate(3 + k / 10, 0.1)
    }

    expect(s.updateView(camera(building))).toBe(1)
    animate()
    expect([...rooms.values()].every((r) => r.lod.level === 1)).toBe(true)
    expect(tagged('detail').some(chainVisible)).toBe(false)
    expect(tagged('small').some(chainVisible)).toBe(true)
    expect(chars().every((c) => c.viewLevel === 1)).toBe(true)
    expect(chars().every((c) => !c.rig.torso.castShadow && !c.rig.details.some((d) => d.visible))).toBe(true)
    expect(screens().every((x) => x.on?.mon.scale === 0.5)).toBe(true)

    expect(s.updateView(camera(far))).toBe(2)
    animate()
    expect(tagged('small').some(chainVisible)).toBe(false)
    expect(chars().every((c) => c.viewLevel === 2 && !c.rig.smalls.some((d) => d.visible))).toBe(true)
    // Bloco emissivo na cor do status do dono: sem textura.
    for (const x of screens()) {
      expect(x.on).toBeNull()
      expect((x.mesh as Mesh).material).toBe(s['kit'].mat.status[x.status])
    }
    // Quem pede permissão fica amarelo; quem trabalha, azul.
    expect(new Set(screens().map((x) => x.status)).has('working')).toBe(true)

    const [r0] = layout.rooms
    expect(s.updateView(camera(near(r0)))).toBe(0)
    animate()
    const r0Screens = rooms.get(r0.id)!.screens.filter((x) => x.state === 'on')
    expect(r0Screens.every((x) => x.on?.mon.scale === 1)).toBe(true)
    const r0Chars = chars().filter((c) => c.brain.roomId === r0.id && c.group.visible)
    expect(r0Chars.length).toBeGreaterThan(0)
    expect(r0Chars.every((c) => c.viewLevel === 0 && c.rig.torso.castShadow && c.rig.details.every((d) => d.visible))).toBe(true)
    s.dispose()
  })

  it('setQuality: LONGE desliga a sombra do sol e liga a névoa suave; voltar desfaz', () => {
    const { s } = setup()
    const sun = s.scene.children.find((o): o is DirectionalLight => o instanceof DirectionalLight)!
    const fog = s.scene.fog as Fog
    expect(fog.near).toBeGreaterThan(250)
    s.shadowDirty = false
    s.setQuality(2, 60)
    expect(sun.castShadow).toBe(false)
    expect(s.castsShadows).toBe(false)
    expect(fog.near).toBeLessThan(60)
    expect(fog.far).toBeGreaterThan(60)
    s.setQuality(1, 35)
    expect(sun.castShadow).toBe(true)
    expect(s.shadowDirty).toBe(true)
    expect(fog.near).toBeGreaterThan(250)
    s.dispose()
  })

  it('shadowDirty só quando algo que projeta sombra muda; ritmo 1 quando só o LONGE anima', () => {
    const { s, layout, chars, near, far } = setup()
    const [r0] = layout.rooms
    s.updateView(camera(near(r0)))
    s.animate(4, 0.1)
    s.shadowDirty = false
    // Nada se mexe (dt 0): a sombra fica como está.
    s.animate(4, 0)
    s.animate(4, 0)
    expect(s.shadowDirty).toBe(false)
    // Personagem que projeta (PERTO) anda: sombra suja.
    const c = chars().find((x) => x.brain.roomId === r0.id && x.group.visible && x.viewLevel === 0)!
    c.brain.x += 0.5
    s.animate(4, 0)
    expect(s.shadowDirty).toBe(true)
    // Mudar de nível também suja; LONGE: só animação de baixa prioridade.
    s.shadowDirty = false
    s.updateView(camera(far))
    expect(s.shadowDirty).toBe(true)
    s.animate(4.1, 0.1)
    expect(s.rate).toBe(1)
    s.updateView(camera(near(r0)))
    s.animate(4.2, 0.1)
    expect(s.rate).toBe(2)
    s.dispose()
  })
})
