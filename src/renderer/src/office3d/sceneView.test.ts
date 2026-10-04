import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectionalLight, Fog, Mesh, PerspectiveCamera, Vector3, type Object3D } from 'three'
import { deriveOfficeModel } from '../office/adapter/model'
import { FX } from './brain'
import { cameraPosition, framePose, type CameraPose } from './cameraRig'
import { Character3D } from './characters'
import type { RoomView, ZoneView } from './decor'
import { demoFeed } from './demoFeed'
import { DEMO_LOOP_MS } from './demoTimeline'
import { snapshotOf } from './events'
import { buildingBounds, layoutOffice, OFFICE_ID } from './layout'
import type { ZoneId } from './officePlan'
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
  const view = internals.rooms.get(OFFICE_ID)!
  const zone = (id: ZoneId): ZoneView => view.zone(id)
  const center = new Vector3()
  /** De perto, olhando a zona de cima (as outras ficam fora do quadro). */
  const near = (id: ZoneId): CameraPose => {
    zone(id).lod.box.getCenter(center)
    return { tx: center.x, ty: 0, tz: center.z, yaw: 0, pitch: 1.2, distance: 6 }
  }
  const building = framePose({ ...buildingBounds(layout.rooms)!, height: 2.8 }, { fovDeg: 50, aspect: ASPECT })
  return { s, layout, feed, view, zone, chars: () => internals.charList, near, building, mid: { ...building, distance: 32 }, far: { ...building, distance: 70 } }
}

const chainVisible = (o: Object3D): boolean => {
  for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false
  return true
}

describe('OfficeScene — culling por zona', () => {
  it('sem câmera (nenhum updateView) fica tudo à vista e completo, como antes', () => {
    const { s, view, chars } = setup()
    expect(view.zones.every((z) => z.group.visible && z.lod.level === 0)).toBe(true)
    expect(chars().every((c) => !c.culled && c.viewLevel === 0)).toBe(true)
    expect(s.rate).toBe(2)
    s.dispose()
  })

  it('zona fora do frustum: grupo invisível, personagem fora da tela sem update, tela sem redesenho; a página fica guardada', () => {
    // Aos 30 s do loop o dev de cada projeto está trabalhando: toda ilha tem tela acesa.
    const { s, layout, view, zone, chars, near, feed } = setup(T0 + 30_000)
    expect(s.updateView(camera(near('island0')))).toBe(0)
    const culled = view.zones.filter((z) => z.lod.culled)
    expect(culled.map((z) => z.id)).toEqual(expect.arrayContaining(['meeting', 'lounge']))
    expect(zone('island0').group.visible).toBe(true)
    for (const z of culled) expect(z.group.visible).toBe(false)
    const out = chars().filter((c) => c.culled)
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((c) => !c.group.visible)).toBe(true)

    const updated = new Set<string>()
    const real = Character3D.prototype.update
    vi.spyOn(Character3D.prototype, 'update').mockImplementation(function (this: Character3D, dt, lod) {
      updated.add(this.key)
      return real.call(this, dt, lod)
    })
    for (let k = 0; k < 10; k++) s.animate(1 + k / 10, 0.1)
    expect(out.some((c) => updated.has(c.key))).toBe(false)
    expect(chars().some((c) => !c.culled && updated.has(c.key))).toBe(true)

    // Feed novo: a ilha à vista redesenha; as telas das zonas de fora só guardam a página.
    const lit = view.screens.filter((x) => x.lod.culled && x.state === 'on')
    expect(lit.length).toBeGreaterThan(0)
    const draws = lit.map((x) => vi.spyOn(x.on!.mon, 'draw'))
    const seen = view.screens.filter((x) => x.zone === 'island0' && x.on)
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
    const { s, view, chars, near } = setup(T0 + 30_000)
    s.updateView(camera(near('lounge')))
    const doorZone = view.doorZone
    expect(doorZone.lod.culled).toBe(true)
    const screen = view.screens.find((sc) => sc.lod.culled && sc.state === 'on' && sc.zone === 'island1') ?? view.screens.find((sc) => sc.lod.culled && sc.state === 'on')!
    const draw = vi.spyOn(screen.on!.mon, 'draw')
    // Enquanto fora: alguém chega na porta e um agente da ilha acumula efeitos.
    const c = chars().find((x) => x.culled && x.brain.visible)!
    c.brain.fx = FX.confetti | FX.smoke | FX.sweat
    const walker = chars().find((x) => x !== c)!.brain
    walker.x = view.doorAt.x - 0.3
    walker.z = view.doorAt.z
    walker.visible = true
    s.animate(2, 0.016)
    expect(view.door.rotation.y).toBe(0)
    expect(s.particles.live).toBe(0)

    s.updateView(camera(near('island1')))
    expect(doorZone.lod.culled).toBe(false)
    expect(doorZone.group.visible).toBe(true)
    expect(view.door.rotation.y).toBeCloseTo(1.35)
    expect(draw).toHaveBeenCalledWith(screen.page, screen.accent)
    s.animate(2.016, 0.016)
    if (!c.culled) {
      expect(c.brain.fx).toBe(0)
      expect(c.group.visible).toBe(true)
      expect(c.group.position.x).toBeCloseTo(c.brain.x)
    }
    expect(s.particles.live).toBe(0)
    s.dispose()
  })
})

describe('OfficeScene — LOD por distância (zona a zona)', () => {
  it('PERTO completo; MÉDIO sem detalhes e tela em meia resolução; LONGE sem pequenos, tela vira bloco na cor do status', () => {
    const { s, view, chars, near, mid, far } = setup(T0 + 30_000)
    const screens = () => view.screens.filter((x) => x.state === 'on')
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

    expect(s.updateView(camera(mid))).toBe(1)
    animate()
    expect(view.zones.every((z) => z.lod.level === 1)).toBe(true)
    expect(tagged('detail').some(chainVisible)).toBe(false)
    expect(tagged('small').some(chainVisible)).toBe(true)
    expect(chars().filter((c) => c.group.visible).every((c) => c.viewLevel === 1)).toBe(true)
    expect(chars().every((c) => c.viewLevel === 0 || (!c.rig.torso.castShadow && !c.rig.details.some((d) => d.visible)))).toBe(true)
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
    expect(new Set(screens().map((x) => x.status)).has('working')).toBe(true)

    expect(s.updateView(camera(near('island0')))).toBe(0)
    animate()
    const mine = view.screens.filter((x) => x.zone === 'island0' && x.state === 'on')
    expect(mine.every((x) => x.on?.mon.scale === 1)).toBe(true)
    const close = chars().filter((c) => c.group.visible && c.viewLevel === 0)
    expect(close.length).toBeGreaterThan(0)
    expect(close.every((c) => c.rig.torso.castShadow && c.rig.details.every((d) => d.visible))).toBe(true)
    s.dispose()
  })

  it('a câmera inicial (o escritório inteiro) põe a frente mais detalhada que o fundo', () => {
    const { s, zone, building } = setup()
    s.updateView(camera(building))
    expect(zone('island0').lod.level).toBeLessThanOrEqual(zone('lounge').lod.level)
    expect(zone('island1').lod.level).toBeLessThanOrEqual(zone('meeting').lod.level)
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
    const { s, chars, near, far } = setup()
    s.updateView(camera(near('island0')))
    s.animate(4, 0.1)
    s.shadowDirty = false
    // Nada se mexe (dt 0, sem andar): a sombra fica como está.
    for (const c of chars()) c.brain.speed = 0
    s.animate(4, 0)
    s.shadowDirty = false
    s.animate(4, 0)
    expect(s.shadowDirty).toBe(false)
    // Personagem que projeta (PERTO) anda: sombra suja.
    const c = chars().find((x) => x.group.visible && x.viewLevel === 0)!
    c.brain.x += 0.5
    s.animate(4, 0)
    expect(s.shadowDirty).toBe(true)
    // Mudar de nível também suja; LONGE: só animação de baixa prioridade.
    s.shadowDirty = false
    s.updateView(camera(far))
    expect(s.shadowDirty).toBe(true)
    s.animate(4.1, 0.1)
    expect(s.rate).toBe(1)
    s.updateView(camera(near('island0')))
    s.animate(4.2, 0.1)
    expect(s.rate).toBe(2)
    s.dispose()
  })
})
