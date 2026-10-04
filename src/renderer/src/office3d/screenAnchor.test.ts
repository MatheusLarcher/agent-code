import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import { cameraPosition, lerpPose, MONITOR_HALF_H, MONITOR_HALF_W, MONITOR_SCREEN_FRONT, monitorPose, type CameraPose } from './cameraRig'
import type { Pt } from './quadTransform'
import { focusView, PointAnchor, PreviewAnchor, ScreenAnchor, type PreviewScene } from './screenAnchor'
import { BUBBLE_TOP } from './speech'

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

describe('ScreenAnchor: a tela HTML encaixada na tela do monitor (homografia)', () => {
  const W = 1400
  const H = 800
  const M = { x: 3, y: 1.12, z: -2 }
  // A pose do foco do motor: a mesma vista da âncora (a faixa do HUD livre).
  const final = monitorPose(M, focusView(50, W, H))

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

  /** Cantos da tela do monitor projetados pela câmera (px), TL TR BR BL. */
  function screenCorners(cam: PerspectiveCamera, width = W, height = H): Pt[] {
    const z = M.z + MONITOR_SCREEN_FRONT
    return [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([sx, sy]) => {
      const v = new Vector3(M.x + sx * MONITOR_HALF_W, M.y + sy * MONITOR_HALF_H, z).project(cam)
      return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height }
    })
  }

  /** Os cantos do elemento, (0,0)…(width,height) do estilo, levados pelo matrix3d escrito (como o navegador). */
  function placedCorners(el: HTMLElement): Pt[] {
    const w = parseFloat(el.style.width)
    const h = parseFloat(el.style.height)
    const m = /^matrix3d\((.+)\)$/.exec(el.style.transform)![1].split(',').map(Number)
    return [[0, 0], [w, 0], [w, h], [0, h]].map(([X, Y]) => {
      const d = m[3] * X + m[7] * Y + m[15]
      return { x: (m[0] * X + m[4] * Y + m[12]) / d, y: (m[1] * X + m[5] * Y + m[13]) / d }
    })
  }

  const maxError = (a: Pt[], b: Pt[]): number => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)))
  const len = (c: Pt[], i: number, j: number): number => Math.hypot(c[j].x - c[i].x, c[j].y - c[i].y)

  function mount(): { el: HTMLElement; anchor: ScreenAnchor } {
    const el = document.createElement('div')
    const anchor = new ScreenAnchor()
    anchor.setElement(el)
    anchor.aim(M)
    return { el, anchor }
  }

  it('na pose final do foco: o tamanho de layout é a tela projetada e o matrix3d leva os cantos aos do monitor (≤ 0,5 px)', () => {
    const { el, anchor } = mount()
    const cam = poseCamera(final)
    anchor.place(cam, W, H)
    const c = screenCorners(cam)
    expect(el.style.width).toBe(`${Math.round((len(c, 0, 1) + len(c, 3, 2)) / 2)}px`)
    expect(el.style.height).toBe(`${Math.round((len(c, 0, 3) + len(c, 1, 2)) / 2)}px`)
    expect([el.style.left, el.style.top, el.style.visibility]).toEqual(['', '', ''])
    expect(maxError(placedCorners(el), c)).toBeLessThanOrEqual(0.5)
    // A tela fica abaixo da faixa do HUD e dentro do palco.
    expect(Math.min(c[0].y, c[1].y)).toBeGreaterThanOrEqual(BUBBLE_TOP - 1)
    expect(Math.max(c[2].y, c[3].y)).toBeLessThanOrEqual(H)
    // O keystone da arfagem: a borda de cima sai mais larga que a de baixo (o retângulo de antes não encaixava).
    expect(len(c, 0, 1) / len(c, 3, 2)).toBeGreaterThan(1.03)
    // Câmera parada: nada é reescrito.
    el.style.transform = 'translate3d(1px, 1px, 0px)'
    anchor.place(cam, W, H)
    expect(el.style.transform).toBe('translate3d(1px, 1px, 0px)')
  })

  it('no meio do voo: o mesmo tamanho de layout, transform novo, ainda nos cantos do monitor', () => {
    const { el, anchor } = mount()
    anchor.place(poseCamera(final), W, H)
    const size = [el.style.width, el.style.height]
    const rest = el.style.transform
    const far: CameraPose = { tx: M.x + 2, ty: 0.8, tz: M.z + 3, yaw: 0.6, pitch: 0.8, distance: 9 }
    const cam = poseCamera(lerpPose(far, final, 0.5))
    anchor.place(cam, W, H)
    expect([el.style.width, el.style.height]).toEqual(size)
    expect(el.style.transform).not.toBe(rest)
    expect(el.style.visibility).toBe('')
    const c = screenCorners(cam)
    expect(maxError(placedCorners(el), c)).toBeLessThanOrEqual(0.5)
    // De longe a tela encolhe pelo transform (o layout fica).
    expect(len(c, 0, 1)).toBeLessThan(parseFloat(size[0]) * 0.6)
  })

  it('palco redimensionado: o tamanho de layout é refeito para o novo aspect', () => {
    const { el, anchor } = mount()
    anchor.place(poseCamera(final), W, H)
    const wide = el.style.width
    const narrow = monitorPose(M, focusView(50, 600, H))
    const cam = poseCamera(narrow, 600, H)
    anchor.place(cam, 600, H)
    expect(el.style.width).not.toBe(wide)
    expect(maxError(placedCorners(el), screenCorners(cam, 600, H))).toBeLessThanOrEqual(0.5)
  })

  it('canto atrás da câmera: esconde; de volta à vista, aparece encaixada', () => {
    const { el, anchor } = mount()
    const far: CameraPose = { tx: M.x + 2, ty: 0.8, tz: M.z + 3, yaw: 0.6, pitch: 0.8, distance: 9 }
    anchor.place(poseCamera(far), W, H)
    expect(el.style.visibility).toBe('')
    // Rente à tela, olhando para a esquerda: os cantos da direita ficam atrás da câmera.
    const z = M.z + MONITOR_SCREEN_FRONT
    const graze = new PerspectiveCamera(50, W / H, 0.05, 250)
    graze.position.set(M.x + 0.3, M.y, z + 0.2)
    graze.lookAt(M.x - 0.7, M.y, z)
    graze.updateMatrixWorld()
    anchor.place(graze, W, H)
    expect(el.style.visibility).toBe('hidden')
    const cam = poseCamera(final)
    anchor.place(cam, W, H)
    expect(el.style.visibility).toBe('')
    expect(maxError(placedCorners(el), screenCorners(cam))).toBeLessThanOrEqual(0.5)
  })

  it('sem monitor: o cartão centrado e sem transform (e visível); com monitor de novo, left/top limpos', () => {
    const { el, anchor } = mount()
    const cam = poseCamera(final)
    anchor.place(cam, W, H)
    expect(el.style.transform).toMatch(/^matrix3d\(/)
    const behind = new PerspectiveCamera(50, W / H, 0.05, 250)
    behind.position.set(M.x, M.y, M.z + 1)
    behind.lookAt(M.x, M.y, M.z + 5) // de costas para o monitor
    behind.updateMatrixWorld()
    anchor.place(behind, W, H)
    expect(el.style.visibility).toBe('hidden')
    anchor.aim(null)
    anchor.place(cam, 1000, 800)
    expect([el.style.left, el.style.top, el.style.width, el.style.height]).toEqual(['290px', '270px', '420px', '260px'])
    expect([el.style.transform, el.style.visibility]).toEqual(['', ''])
    anchor.aim(M)
    anchor.place(cam, W, H)
    expect([el.style.left, el.style.top]).toEqual(['', ''])
    expect(maxError(placedCorners(el), screenCorners(cam))).toBeLessThanOrEqual(0.5)
  })
})
