import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import { PointAnchor, PreviewAnchor, type PreviewScene } from './screenAnchor'
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
