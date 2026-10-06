import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import {
  cameraPosition,
  lerpPose,
  MONITOR_PLANE,
  monitorPose,
  planeEdge,
  screenPose,
  TV_PLANE,
  tvPose,
  type CameraPose,
  type MonitorAt,
  type ScreenPlane,
  type ViewSize
} from './cameraRig'
import { CONSOLE_AT, CONSOLE_PLANE } from './engineTv'
import type { Pt } from './quadTransform'
import { focusView, isAxisRect, PointAnchor, PreviewAnchor, ScreenAnchor, type PreviewScene } from './screenAnchor'
import { BUBBLE_TOP } from './speech'

afterEach(() => {
  vi.unstubAllGlobals()
})

function camera(): PerspectiveCamera {
  const cam = new PerspectiveCamera(50, 1000 / 800, 0.1, 100)
  cam.position.set(0, 2, 10)
  cam.lookAt(0, 1, 0)
  cam.updateMatrixWorld()
  return cam
}

function card(w = 300, h = 120): HTMLElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'offsetWidth', { value: w })
  Object.defineProperty(el, 'offsetHeight', { value: h })
  return el
}

const xy = (el: HTMLElement): [number, number] => {
  const m = /translate3d\((-?\d+)px, (-?\d+)px, 0\)/.exec(el.style.transform)
  return m ? [Number(m[1]), Number(m[2])] : [NaN, NaN]
}

describe('PointAnchor: a prévia segue um ponto do mundo só pelo transform', () => {
  it('cartão centrado acima do ponto; só escreve quando o px muda; sem lugar acima, abaixo; atrás da câmera some', () => {
    const el = card()
    const a = new PointAnchor()
    a.setElement(el)
    const cam = camera()
    a.place({ x: 0, y: 1, z: 0 }, cam, 1000, 800)
    const [x, y] = xy(el)
    expect(x).toBe(350) // centrado em 500
    expect(y + 120).toBeLessThan(400) // acima do ponto (o meio da tela)
    // Mesma câmera, mesmo ponto: nada é escrito (a marca fica).
    el.style.transform = 'translate3d(1px, 1px, 0px)'
    a.place({ x: 0, y: 1, z: 0 }, cam, 1000, 800)
    expect(el.style.transform).toBe('translate3d(1px, 1px, 0px)')
    a.place({ x: 1, y: 1, z: 0 }, cam, 1000, 800)
    expect(xy(el)[0]).toBeGreaterThan(350)
    // Ponto no alto da tela: o cartão não sobe na faixa do HUD — vai para baixo do ponto.
    a.place({ x: 0, y: 5.4, z: 0 }, cam, 1000, 800)
    expect(xy(el)[1]).toBeGreaterThanOrEqual(BUBBLE_TOP)
    // Atrás da câmera: escondido (e volta quando reaparece).
    a.place({ x: 0, y: 1, z: 20 }, cam, 1000, 800)
    expect(el.style.visibility).toBe('hidden')
    a.place({ x: 0, y: 1, z: 0 }, cam, 1000, 800)
    expect(el.style.visibility).toBe('')
  })

  it('PreviewAnchor: acima do monitor do agente (data-key); sem mesa, acima da cabeça; sem cartão, nada', () => {
    const cam = camera()
    const scene: PreviewScene = {
      character: (key) => (key === 'conv:a' ? { screenDesk: { roomId: 'r', index: 0 } } : key === 'po:r' ? { screenDesk: null } : undefined),
      room: () => ({ desks: [{ x: 0, z: 0.25 }] }),
      headWorldPosition: (key, out: Vector3) => (key === 'po:r' ? (out.set(2, 1.6, 0), true) : false)
    }
    const p = new PreviewAnchor()
    p.place(scene, cam, 1000, 800) // sem elemento: não faz nada
    const el = card()
    el.dataset.key = 'conv:a'
    p.setElement(el)
    p.place(scene, cam, 1000, 800)
    expect(xy(el)[0]).toBe(350)
    const po = card()
    po.dataset.key = 'po:r'
    p.setElement(po)
    p.place(scene, cam, 1000, 800)
    expect(xy(po)[0]).toBeGreaterThan(350)
  })
})

describe('isAxisRect: quando a tela entra no modo plano', () => {
  const rect = (x: number, y: number, w: number, h: number): [Pt, Pt, Pt, Pt] => [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h }
  ]
  /** O retângulo 800 × 450 girado `deg` graus em volta do centro. */
  const turned = (deg: number): [Pt, Pt, Pt, Pt] => {
    const a = (deg * Math.PI) / 180
    return rect(-400, -225, 800, 450).map((p) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) })) as [Pt, Pt, Pt, Pt]
  }
  /** A borda de cima `k` px mais larga de cada lado (o keystone da arfagem). */
  const keystone = (k: number): [Pt, Pt, Pt, Pt] => [{ x: -k, y: 0 }, { x: 800 + k, y: 0 }, { x: 800, y: 450 }, { x: 0, y: 450 }]

  it('retângulo alinhado do tamanho de layout, em qualquer posição: sim — com a sobra do arredondamento do layout', () => {
    expect(isAxisRect(rect(10.3, 20.7, 800, 450), 800, 450)).toBe(true)
    expect(isAxisRect(rect(10, 20, 800.5, 449.5), 800, 450)).toBe(true)
    expect(isAxisRect(keystone(0.4), 800, 450)).toBe(true)
    expect(isAxisRect(turned(0.03), 800, 450)).toBe(true)
  })

  it('a folga é por canto: 0,5 px passa, 0,6 px não', () => {
    expect(isAxisRect(rect(-0.5, 0, 801, 450), 800, 450)).toBe(true)
    expect(isAxisRect(rect(-0.6, 0, 801.2, 450), 800, 450)).toBe(false)
  })

  it('trapézio (a arfagem), outra escala (o dolly reto), girado ou NaN: não', () => {
    expect(isAxisRect(keystone(1), 800, 450)).toBe(false)
    expect(isAxisRect(rect(0, 0, 802, 451), 800, 450)).toBe(false)
    expect(isAxisRect(rect(0, 0, 798, 450), 800, 450)).toBe(false)
    expect(isAxisRect(turned(0.2), 800, 450)).toBe(false)
    expect(isAxisRect(rect(NaN, 0, 800, 450), 800, 450)).toBe(false)
  })
})

describe('ScreenAnchor: a tela HTML encaixada na tela do monitor, da TV e do console', () => {
  const W = 1400
  const H = 800
  const M = { x: 3, y: 1.12, z: -2 }
  const TV: MonitorAt = { x: 5.05, y: 1.6, z: -6.5, dir: 1 }
  // A vista do foco do motor (a faixa do HUD livre): a mesma da âncora.
  const VIEW = focusView(50, W, H)
  const final = monitorPose(M, VIEW)
  const far: CameraPose = { tx: M.x + 2, ty: 0.8, tz: M.z + 3, yaw: 0.6, pitch: 0.8, distance: 9 }

  /** A câmera do motor numa pose (como o CameraSync). */
  function poseCamera(pose: CameraPose, width = W, height = H): PerspectiveCamera {
    const cam = new PerspectiveCamera(50, width / height, 0.05, 250)
    const c = cameraPosition(pose)
    cam.position.set(c.x, c.y, c.z)
    cam.lookAt(pose.tx, pose.ty, pose.tz)
    cam.updateMatrixWorld()
    cam.updateProjectionMatrix()
    return cam
  }

  /** Cantos da tela `plane` centrada em `at` projetados pela câmera (px), TL TR BR BL. */
  function planeCorners(cam: PerspectiveCamera, at: MonitorAt = M, plane: ScreenPlane = MONITOR_PLANE, width = W, height = H): Pt[] {
    const dir = at.dir ?? 1
    const z = at.z + dir * plane.front
    return [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([sx, sy]) => {
      const e = planeEdge(plane, sy)
      const v = new Vector3(at.x + sx * dir * plane.halfW, at.y + e.dy, z + e.dz).project(cam)
      return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height }
    })
  }

  /** Os cantos do elemento como o navegador os põe: left/top/width/height e, com transform, o matrix3d (a partir do 0,0). */
  function placedCorners(el: HTMLElement): Pt[] {
    const w = parseFloat(el.style.width)
    const h = parseFloat(el.style.height)
    const box = [[0, 0], [w, 0], [w, h], [0, h]]
    if (!el.style.transform) {
      const x = parseFloat(el.style.left || '0')
      const y = parseFloat(el.style.top || '0')
      return box.map(([X, Y]) => ({ x: x + X, y: y + Y }))
    }
    const m = /^matrix3d\((.+)\)$/.exec(el.style.transform)![1].split(',').map(Number)
    return box.map(([X, Y]) => {
      const d = m[3] * X + m[7] * Y + m[15]
      return { x: (m[0] * X + m[4] * Y + m[12]) / d, y: (m[1] * X + m[5] * Y + m[13]) / d }
    })
  }

  const maxError = (a: Pt[], b: Pt[]): number => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)))
  /** O maior desvio num eixo entre os cantos. */
  const maxAxis = (a: Pt[], b: Pt[]): number => Math.max(...a.map((p, i) => Math.max(Math.abs(p.x - b[i].x), Math.abs(p.y - b[i].y))))
  const len = (c: Pt[], i: number, j: number): number => Math.hypot(c[j].x - c[i].x, c[j].y - c[i].y)
  const center = (c: Pt[]): Pt => ({ x: (c[0].x + c[2].x) / 2, y: (c[0].y + c[2].y) / 2 })
  /** `v` cai num px de dispositivo inteiro (múltiplo de 1/dpr). */
  const onDevicePx = (v: number, dpr: number): boolean => Math.abs(v * dpr - Math.round(v * dpr)) < 1e-6
  /** Parada no modo plano, o desvio de cada canto: até 0,25 px do arredondamento do layout mais meio px de dispositivo do encaixe. */
  const flatTol = (dpr: number): number => 0.25 + 0.5 / dpr + 1e-9

  function mount(at: MonitorAt = M, plane: ScreenPlane = MONITOR_PLANE): { el: HTMLElement; anchor: ScreenAnchor } {
    const el = document.createElement('div')
    const anchor = new ScreenAnchor()
    anchor.setElement(el)
    anchor.aim(at, plane)
    return { el, anchor }
  }

  const SCREENS: ReadonlyArray<{ name: string; at: MonitorAt; plane: ScreenPlane; pose: (v: ViewSize) => CameraPose }> = [
    { name: 'monitor', at: M, plane: MONITOR_PLANE, pose: (v) => monitorPose(M, v) },
    { name: 'monitor da mesa de fundo', at: { ...M, dir: -1 }, plane: MONITOR_PLANE, pose: (v) => monitorPose({ ...M, dir: -1 }, v) },
    { name: 'TV', at: TV, plane: TV_PLANE, pose: (v) => tvPose(TV, v) },
    { name: 'console da Central', at: CONSOLE_AT, plane: CONSOLE_PLANE, pose: (v) => screenPose(CONSOLE_AT, CONSOLE_PLANE, v) }
  ]

  for (const dpr of [1, 1.25, 1.5]) {
    it.each(SCREENS)(`$name parado no foco (dpr ${dpr}): sem transform, left/top em px de dispositivo e a tela nos cantos dela`, ({ at, plane, pose }) => {
      vi.stubGlobal('devicePixelRatio', dpr)
      const { el, anchor } = mount(at, plane)
      const cam = poseCamera(pose(VIEW))
      anchor.place(cam, W, H)
      const c = planeCorners(cam, at, plane)
      expect([el.style.transform, el.style.visibility]).toEqual(['', ''])
      // O tamanho de layout é a tela projetada, em px inteiros; left/top caem em px de dispositivo inteiros.
      expect(el.style.width).toBe(`${Math.round((len(c, 0, 1) + len(c, 3, 2)) / 2)}px`)
      expect(el.style.height).toBe(`${Math.round((len(c, 0, 3) + len(c, 1, 2)) / 2)}px`)
      expect(onDevicePx(parseFloat(el.style.left), dpr)).toBe(true)
      expect(onDevicePx(parseFloat(el.style.top), dpr)).toBe(true)
      expect(maxAxis(placedCorners(el), c)).toBeLessThanOrEqual(flatTol(dpr))
      // De frente: a tela projetada é um retângulo (sem o keystone da arfagem).
      expect(len(c, 0, 1) / len(c, 3, 2)).toBeCloseTo(1, 6)
      // A tela fica abaixo da faixa do HUD e dentro do palco.
      expect(Math.min(c[0].y, c[1].y)).toBeGreaterThanOrEqual(BUBBLE_TOP - 1)
      expect(Math.max(c[2].y, c[3].y)).toBeLessThanOrEqual(H)
    })
  }

  it('no meio do voo: matrix3d (a perspectiva), left/top no 0 do CSS e o mesmo tamanho de layout — ainda nos cantos do monitor', () => {
    const { el, anchor } = mount()
    anchor.place(poseCamera(final), W, H)
    const size = [el.style.width, el.style.height]
    const cam = poseCamera(lerpPose(far, final, 0.5))
    anchor.place(cam, W, H)
    expect(el.style.transform).toMatch(/^matrix3d\(/)
    expect([el.style.left, el.style.top, el.style.visibility]).toEqual(['', '', ''])
    expect([el.style.width, el.style.height]).toEqual(size)
    const c = planeCorners(cam)
    expect(maxError(placedCorners(el), c)).toBeLessThanOrEqual(0.5)
    // De longe a tela encolhe pelo transform (o layout fica).
    expect(len(c, 0, 1)).toBeLessThan(parseFloat(size[0]) * 0.6)
  })

  it('do voo ao repouso: só a posição muda (width/height não são reescritos, o layout fica) e o centro anda menos de meio px; parada, nada é escrito; de volta ao voo, left/top limpos', () => {
    const { el, anchor } = mount()
    anchor.place(poseCamera(lerpPose(far, final, 0.9)), W, H)
    expect(el.style.transform).toMatch(/^matrix3d\(/)
    const size = [el.style.width, el.style.height]
    // Marcas: o que a troca não reescrever fica como está.
    el.style.width = '7px'
    el.style.height = '5px'
    const cam = poseCamera(final)
    anchor.place(cam, W, H)
    expect(el.style.transform).toBe('')
    expect([el.style.width, el.style.height]).toEqual(['7px', '5px'])
    el.style.width = size[0]
    el.style.height = size[1]
    const c = planeCorners(cam)
    const p = placedCorners(el)
    expect(Math.abs(center(p).x - center(c).x)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(center(p).y - center(c).y)).toBeLessThanOrEqual(0.5)
    expect(maxAxis(p, c)).toBeLessThanOrEqual(flatTol(1))
    // Parada: nada é reescrito.
    el.style.left = '1px'
    anchor.place(cam, W, H)
    expect(el.style.left).toBe('1px')
    // De volta ao voo: o matrix3d a partir do 0,0 do CSS.
    anchor.place(poseCamera(lerpPose(final, far, 0.3)), W, H)
    expect(el.style.transform).toMatch(/^matrix3d\(/)
    expect([el.style.left, el.style.top]).toEqual(['', ''])
  })

  it('dolly reto (de frente, mais longe): um retângulo de outra escala — fica no matrix3d, sem pulo de escala', () => {
    const { el, anchor } = mount()
    anchor.place(poseCamera({ ...final, distance: final.distance * 1.3 }), W, H)
    expect(el.style.transform).toMatch(/^matrix3d\(/)
  })

  it('a janela muda de escala (dpr) com a câmera parada: o encaixe é refeito nos px do novo dispositivo', () => {
    const { el, anchor } = mount()
    const cam = poseCamera(final)
    anchor.place(cam, W, H)
    const c = planeCorners(cam)
    const exact = (center(c).x - parseFloat(el.style.width) / 2) * 1.5
    expect(parseFloat(el.style.left)).not.toBeCloseTo(Math.round(exact) / 1.5, 6) // em dpr 1 o encaixe era outro
    vi.stubGlobal('devicePixelRatio', 1.5)
    anchor.place(cam, W, H)
    expect(parseFloat(el.style.left)).toBeCloseTo(Math.round(exact) / 1.5, 6)
    expect(onDevicePx(parseFloat(el.style.top), 1.5)).toBe(true)
  })

  it('palco redimensionado: o tamanho de layout é refeito para o novo aspect (e, parada, a tela fica plana)', () => {
    const { el, anchor } = mount()
    anchor.place(poseCamera(final), W, H)
    const wide = el.style.width
    const narrow = monitorPose(M, focusView(50, 600, H))
    const cam = poseCamera(narrow, 600, H)
    anchor.place(cam, 600, H)
    expect(el.style.width).not.toBe(wide)
    expect(el.style.transform).toBe('')
    expect(maxAxis(placedCorners(el), planeCorners(cam, M, MONITOR_PLANE, 600, H))).toBeLessThanOrEqual(flatTol(1))
  })

  it('canto atrás da câmera: esconde; de volta à vista, aparece encaixada', () => {
    const { el, anchor } = mount()
    anchor.place(poseCamera(far), W, H)
    expect(el.style.visibility).toBe('')
    // Rente à tela, olhando para a esquerda: os cantos da direita ficam atrás da câmera.
    const z = M.z + MONITOR_PLANE.front
    const graze = new PerspectiveCamera(50, W / H, 0.05, 250)
    graze.position.set(M.x + 0.3, M.y, z + 0.2)
    graze.lookAt(M.x - 0.7, M.y, z)
    graze.updateMatrixWorld()
    anchor.place(graze, W, H)
    expect(el.style.visibility).toBe('hidden')
    const cam = poseCamera(final)
    anchor.place(cam, W, H)
    expect(el.style.visibility).toBe('')
    expect(maxAxis(placedCorners(el), planeCorners(cam))).toBeLessThanOrEqual(flatTol(1))
  })

  it('sem monitor: o cartão centrado e sem transform (e visível); com monitor de novo, no voo left/top limpos e, parada, o modo plano', () => {
    const { el, anchor } = mount()
    const flight = poseCamera(lerpPose(far, final, 0.5))
    anchor.place(flight, W, H)
    expect(el.style.transform).toMatch(/^matrix3d\(/)
    const behind = new PerspectiveCamera(50, W / H, 0.05, 250)
    behind.position.set(M.x, M.y, M.z + 1)
    behind.lookAt(M.x, M.y, M.z + 5) // de costas para o monitor
    behind.updateMatrixWorld()
    anchor.place(behind, W, H)
    expect(el.style.visibility).toBe('hidden')
    anchor.aim(null)
    anchor.place(flight, 1000, 800)
    expect([el.style.left, el.style.top, el.style.width, el.style.height]).toEqual(['290px', '270px', '420px', '260px'])
    expect([el.style.transform, el.style.visibility]).toEqual(['', ''])
    anchor.aim(M)
    anchor.place(flight, W, H)
    expect([el.style.left, el.style.top]).toEqual(['', ''])
    expect(maxError(placedCorners(el), planeCorners(flight))).toBeLessThanOrEqual(0.5)
    const cam = poseCamera(final)
    anchor.place(cam, W, H)
    expect(el.style.transform).toBe('')
    expect(maxAxis(placedCorners(el), planeCorners(cam))).toBeLessThanOrEqual(flatTol(1))
  })
})

describe('CSS da tela (office3d.css, tvFocus.css)', () => {
  const read = (file: string): string => readFileSync(resolve(process.cwd(), 'src/renderer/src/office3d', file), 'utf8')
  const css = read('office3d.css')
  const block = (sel: string): string => {
    const start = css.indexOf(`\n${sel} {`)
    expect(start, sel).toBeGreaterThan(-1)
    return css.slice(start, css.indexOf('}', start))
  }
  /** O que faz o Chromium rasterizar a camada fora da escala 1 (o texto borra). */
  const BLUR = /will-change|filter\s*:|mix-blend-mode/

  it('a âncora segura os position: fixed de dentro (contain: layout, sem paint, que cortaria o que vaza); o vidro cobre a tela sem pegar o mouse, com no máximo 5% de branco', () => {
    const anchor = block('.o3d-screen-anchor')
    const glass = block('.o3d-screen-anchor::after')
    expect(anchor).toMatch(/\n\s*contain: layout;/)
    expect(anchor).not.toMatch(/contain:[^;]*paint/)
    expect(glass).toMatch(/\n\s*pointer-events: none;/)
    expect(glass).toMatch(/\n\s*inset: 0;/)
    const whites = [...glass.matchAll(/rgba\(255, 255, 255, ([\d.]+)\)/g)].map((m) => Number(m[1]))
    expect(whites.length).toBeGreaterThan(0)
    expect(Math.max(...whites)).toBeLessThanOrEqual(0.05)
  })

  it('nada de will-change, filter, backdrop-filter nem mix-blend-mode na âncora, no vidro e nas molduras da TV e do console', () => {
    for (const b of [block('.o3d-screen-anchor'), block('.o3d-screen-anchor::after'), block('.o3d-console-screen'), read('tvFocus.css')]) expect(b).not.toMatch(BLUR)
  })
})
