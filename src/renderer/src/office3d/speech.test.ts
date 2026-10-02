import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import type { AgentStatus, OfficeSnapshot } from './events'
import { COMPACT_H, COMPACT_W, FONT_PX, TTL_MS, seededRng } from './quips'
import { ANCHOR_UP, bubbleScale, MAX_BUBBLES, MID_SCALE, MIN_FONT_PX, SCALE_MID_M, SCALE_NEAR_M, Speech } from './speech'

const W = 1600
const H = 900
const NOW = 1_700_000_000_000

function status(key: string, over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    key,
    convId: key,
    role: 'principal',
    phase: 'working',
    tool: null,
    lastUserText: 'oi',
    busySinceMs: NOW - 1_000,
    idleSinceMs: null,
    contextPct: null,
    permission: null,
    error: null,
    usageExhausted: null,
    speaking: false,
    stalledMs: 0,
    ...over
  }
}

const reading = (key: string, i: number): AgentStatus => status(key, { tool: { id: `t${i}`, name: 'Read', kind: 'read', target: `f${i}.ts`, detail: '' } })
const asking = (key: string): AgentStatus => status(key, { phase: 'waiting-permission', permission: { tool: 'Bash', detail: 'rm -rf dist' } })
const failing = (key: string): AgentStatus => status(key, { phase: 'error', error: 'API Error: 529' })
const snap = (list: AgentStatus[]): OfficeSnapshot => ({ at: NOW, agents: new Map(list.map((s) => [s.key, s])), convs: new Map() })

let host: HTMLDivElement
let speech: Speech | null = null
let camera: PerspectiveCamera
const heads = new Map<string, Vector3>()
const head = (key: string, out: Vector3): boolean => {
  const h = heads.get(key)
  if (!h) return false
  out.copy(h)
  return true
}
const bubble = (key: string): HTMLElement => host.querySelector<HTMLElement>(`.qb[data-key="${key}"]`)!
const shownKeys = (): string[] =>
  [...host.querySelectorAll<HTMLElement>('.qb')]
    .filter((el) => !el.hidden && el.style.opacity === '')
    .map((el) => el.dataset.key!)
    .sort()
const xOf = (el: HTMLElement): number => Number(/translate3d\((-?[\d.]+)px/.exec(el.style.transform)?.[1])
const yOf = (el: HTMLElement): number => Number(/translate3d\([^,]+, (-?[\d.]+)px/.exec(el.style.transform)?.[1])
const scaleOf = (el: HTMLElement): number => Number(/ scale\(([\d.]+)\)/.exec(el.style.transform)?.[1])
/** Tela (px) de um ponto do mundo. */
const toPx = (v: Vector3): { x: number; y: number } => {
  const p = v.clone().project(camera)
  return { x: ((p.x + 1) / 2) * W, y: ((1 - p.y) / 2) * H }
}
/** Medida que a camada lê no medidor (o jsdom não tem layout); devolve o espião da largura. */
function measured(w: number, h: number) {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(h)
  return vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(w)
}
type Rect = readonly [number, number, number, number]
/** Retângulo do balão na tela: inteiro (w×h na escala do transform) ou ícone compacto. */
function rectOf(el: HTMLElement, w: number, h: number): Rect {
  const [x, y] = [xOf(el), yOf(el)]
  if (el.classList.contains('qb-compact')) return [x - COMPACT_W / 2, y - COMPACT_H, x + COMPACT_W / 2, y]
  const s = scaleOf(el)
  return [x - (w * s) / 2, y - h * s, x + (w * s) / 2, y]
}
const overlaps = (a: Rect, b: Rect): boolean => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
const liftOf = (el: HTMLElement): number => (el.classList.contains('qb-up2') ? 2 : el.classList.contains('qb-up1') ? 1 : 0)

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  camera = new PerspectiveCamera(50, W / H, 0.05, 250)
  camera.position.set(0, 6, 12)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  heads.clear()
})

afterEach(() => {
  speech?.dispose()
  speech = null
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Speech — balões ligados ao motor', () => {
  it(`no máximo ${MAX_BUBBLES} à vista: prioridade primeiro, depois a proximidade da câmera`, () => {
    speech = new Speech(host, () => {}, seededRng(1))
    const list: AgentStatus[] = []
    for (let i = 0; i < 10; i++) {
      list.push(reading(`r${i}`, i))
      heads.set(`r${i}`, new Vector3(-4 + i * 0.8, 1.2, 4 - i)) // r0 é o mais perto
    }
    list.push(asking('p0'), failing('e0'))
    heads.set('p0', new Vector3(-3, 1.2, -14))
    heads.set('e0', new Vector3(3, 1.2, -14))
    expect(speech.feed(snap(list), [], NOW)).toBe(true)
    speech.place(camera, W, H, false, head)
    expect(MAX_BUBBLES).toBeGreaterThanOrEqual(6)
    expect(MAX_BUBBLES).toBeLessThanOrEqual(8)
    expect(speech.shown).toBe(MAX_BUBBLES)
    // Permissão e erro (longe) entram antes de qualquer progresso; o resto, os mais perto.
    const nearest = Array.from({ length: MAX_BUBBLES - 2 }, (_, i) => `r${i}`)
    expect(shownKeys()).toEqual(['e0', 'p0', ...nearest].sort())
  })

  it('zoom LONGE: só permissão e erro, como ícone compacto', () => {
    speech = new Speech(host, () => {}, seededRng(2))
    heads.set('r0', new Vector3(0, 1.2, 0))
    heads.set('p0', new Vector3(-2, 1.2, 0))
    heads.set('e0', new Vector3(2, 1.2, 0))
    speech.feed(snap([reading('r0', 0), asking('p0'), failing('e0')]), [], NOW)
    speech.place(camera, W, H, true, head)
    expect(shownKeys()).toEqual(['e0', 'p0'])
    expect(host.querySelector('.qb-layer')!.classList.contains('qb-compact')).toBe(true)
    speech.place(camera, W, H, false, head)
    expect(shownKeys()).toEqual(['e0', 'p0', 'r0'])
    expect(host.querySelector('.qb-layer')!.classList.contains('qb-compact')).toBe(false)
  })

  it('cabeça fora da tela, atrás da câmera ou escondida: o balão não é posicionado (só some)', () => {
    speech = new Speech(host, () => {}, seededRng(3))
    heads.set('a', new Vector3(0, 1.2, 0))
    heads.set('atras', new Vector3(0, 6, 30)) // atrás da câmera
    heads.set('fora', new Vector3(80, 1.2, 0)) // muito à direita
    speech.feed(snap([reading('a', 0), reading('atras', 1), reading('fora', 2), reading('sumido', 3)]), [], NOW)
    speech.place(camera, W, H, false, head)
    expect(shownKeys()).toEqual(['a'])
    for (const k of ['atras', 'fora', 'sumido']) {
      expect(bubble(k).style.transform).toBe('')
      expect(bubble(k).style.opacity).toBe('0')
    }
    // Saiu da tela depois de posicionado: some, e o transform fica onde estava.
    const before = bubble('a').style.transform
    heads.set('a', new Vector3(-90, 1.2, 0))
    speech.place(camera, W, H, false, head)
    expect(bubble('a').style.opacity).toBe('0')
    expect(bubble('a').style.transform).toBe(before)
  })

  it('acompanha a cabeça andando; a ponta fica acima da cabeça; x limitado para não cortar na borda', () => {
    speech = new Speech(host, () => {}, seededRng(4))
    heads.set('a', new Vector3(0, 1.2, 0))
    speech.feed(snap([reading('a', 0)]), [], NOW)
    speech.place(camera, W, H, false, head)
    const el = bubble('a')
    const x0 = xOf(el)
    expect(x0).toBeCloseTo(W / 2, -1)
    // A ponta fica acima do centro da cabeça projetado.
    const headY = ((1 - new Vector3(0, 1.2, 0).project(camera).y) / 2) * H
    const tipY = Number(/translate3d\([^,]+, (-?[\d.]+)px/.exec(el.style.transform)?.[1])
    expect(tipY).toBeLessThan(headY)
    expect(ANCHOR_UP).toBeGreaterThan(0.5)
    heads.get('a')!.x = 2
    speech.place(camera, W, H, false, head)
    expect(xOf(el)).toBeGreaterThan(x0 + 50)
    // Cabeça encostada na borda direita: o x recua para o balão caber inteiro.
    let xs = 0
    while (new Vector3(xs, 1.2, 0).project(camera).x < 0.99) xs += 0.05
    heads.get('a')!.set(xs, 1.2, 0)
    speech.place(camera, W, H, false, head)
    expect(el.style.opacity).toBe('')
    expect(xOf(el)).toBeLessThan(W - 40)
  })

  it('agentes lado a lado: o mais importante fica na cabeça, os outros sobem com a linha-guia até a cabeça; nada se cobre', () => {
    measured(180, 60)
    speech = new Speech(host, () => {}, seededRng(8))
    heads.set('p0', new Vector3(0, 1.2, 0))
    heads.set('e0', new Vector3(-0.4, 1.2, 0.2))
    heads.set('r0', new Vector3(0.4, 1.2, 0))
    speech.feed(snap([reading('r0', 0), asking('p0'), failing('e0')]), [], NOW)
    speech.place(camera, W, H, false, head)
    expect(shownKeys()).toEqual(['e0', 'p0', 'r0'])
    // Prioridade: permissão (70) na cabeça, erro (60) um andar acima, progresso (20) dois.
    expect(['p0', 'e0', 'r0'].map((k) => liftOf(bubble(k)))).toEqual([0, 1, 2])
    expect(yOf(bubble('p0'))).toBeCloseTo(toPx(new Vector3(0, 1.2 + ANCHOR_UP, 0)).y, -1)
    const rects = ['p0', 'e0', 'r0'].map((k) => rectOf(bubble(k), 180, 60))
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i], rects[j])).toBe(false)
    // A linha-guia do erro sai da ponta dele e acaba logo acima da cabeça dele (entre a cabeça e a ponta sem empilhar).
    for (const [k, h] of [['e0', heads.get('e0')!], ['r0', heads.get('r0')!]] as const) {
      const el = bubble(k)
      const m = /rotate\((-?[\d.]+)rad\) scaleY\((\d+)\)/.exec(el.querySelector<HTMLElement>('.qb-lead')!.style.transform)!
      const [ang, len, s] = [Number(m[1]), Number(m[2]), scaleOf(el)]
      const end = { x: xOf(el) - len * s * Math.sin(ang), y: yOf(el) + len * s * Math.cos(ang) }
      const top = toPx(h.clone().setY(h.y + ANCHOR_UP))
      const center = toPx(h)
      expect(end.y).toBeGreaterThan(top.y)
      expect(end.y).toBeLessThan(center.y)
      expect(Math.abs(end.x - (center.x + (top.x - center.x) * 0.3))).toBeLessThan(2)
    }
  })

  it('sem lugar para subir: vira ícone compacto (só aquele balão); com folga, volta inteiro', () => {
    measured(200, 60)
    speech = new Speech(host, () => {}, seededRng(9))
    // Três pedindo permissão juntos (pilha de 3) e um quarto ao lado, cuja cabeça fica livre.
    const at = { a: -0.3, b: 0, c: 0.3, d: 1.65 }
    for (const [k, x] of Object.entries(at)) heads.set(k, new Vector3(x, 1.2, 0))
    speech.feed(snap(Object.keys(at).map(asking)), [], NOW)
    speech.place(camera, W, H, false, head)
    expect(shownKeys()).toEqual(['a', 'b', 'c', 'd'])
    expect(bubble('d').classList.contains('qb-compact')).toBe(true)
    expect(['a', 'b', 'c'].map((k) => liftOf(bubble(k))).sort()).toEqual([0, 1, 2])
    expect(host.querySelector('.qb-layer')!.classList.contains('qb-compact')).toBe(false)
    const rects = ['a', 'b', 'c', 'd'].map((k) => rectOf(bubble(k), 200, 60))
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i], rects[j])).toBe(false)
    // Os outros saem de perto: o quarto volta a ser o balão inteiro.
    for (const k of ['a', 'b', 'c']) heads.get(k)!.x -= 4
    speech.place(camera, W, H, false, head)
    expect(bubble('d').classList.contains('qb-compact')).toBe(false)
  })

  it('dois de mesma prioridade à mesma distância não trocam de andar quando um chega um pouco mais perto', () => {
    measured(180, 60)
    speech = new Speech(host, () => {}, seededRng(12))
    heads.set('a', new Vector3(-0.3, 1.2, 0))
    heads.set('b', new Vector3(0.3, 1.2, 0))
    speech.feed(snap([asking('a'), asking('b')]), [], NOW)
    speech.place(camera, W, H, false, head)
    const [down, up] = liftOf(bubble('a')) === 0 ? ['a', 'b'] : ['b', 'a']
    expect(liftOf(bubble(up))).toBe(1)
    // O de cima fica ~4% mais perto e volta (cabeça balançando, câmera andando): ninguém troca.
    for (const dz of [0.5, -0.5, 0.5, -0.5, 0.5]) {
      heads.get(up)!.z += dz
      speech.place(camera, W, H, false, head)
      expect([liftOf(bubble(down)), liftOf(bubble(up))]).toEqual([0, 1])
    }
  })

  it('escala pela distância: ~1 perto, ~0,8 no médio, sem a fonte efetiva ficar abaixo de 11 px', () => {
    expect([bubbleScale(5), bubbleScale(SCALE_NEAR_M), bubbleScale(Number.NaN)]).toEqual([1, 1, 1])
    expect(bubbleScale(SCALE_MID_M)).toBeCloseTo(MID_SCALE)
    expect(bubbleScale(80)).toBeCloseTo(MID_SCALE)
    let prev = Infinity
    for (let d = 0; d <= 200; d += 0.25) {
      const s = bubbleScale(d)
      expect(s).toBeLessThanOrEqual(prev)
      expect(s * FONT_PX).toBeGreaterThanOrEqual(MIN_FONT_PX)
      prev = s
    }
    // No palco: cabeça a ~9 m em escala 1; cabeça a ~30 m em 0,8.
    speech = new Speech(host, () => {}, seededRng(10))
    heads.set('perto', new Vector3(-1.5, 1.2, 4))
    heads.set('medio', new Vector3(3, 1.2, -18))
    speech.feed(snap([reading('perto', 0), reading('medio', 1)]), [], NOW)
    speech.place(camera, W, H, false, head)
    expect(shownKeys()).toEqual(['medio', 'perto'])
    expect([scaleOf(bubble('perto')), scaleOf(bubble('medio'))]).toEqual([1, MID_SCALE])
    expect(MID_SCALE * FONT_PX).toBeGreaterThanOrEqual(MIN_FONT_PX)
  })

  it('mede o balão só quando a fala muda; nenhum quadro lê layout', () => {
    const width = measured(150, 40)
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    const style = vi.spyOn(window, 'getComputedStyle')
    speech = new Speech(host, () => {}, seededRng(11))
    heads.set('a', new Vector3(-2, 1.2, 0))
    heads.set('b', new Vector3(2, 1.2, 0))
    speech.feed(snap([reading('a', 0), asking('b')]), [], NOW)
    expect(width.mock.calls).toHaveLength(2) // uma leitura por fala nova
    for (let i = 0; i < 100; i++) {
      heads.get('a')!.x += 0.01 // andando
      speech.place(camera, W, H, i % 2 === 0, head)
    }
    speech.feed(snap([reading('a', 0), asking('b')]), [], NOW + 100) // mesmas falas
    for (let i = 0; i < 10; i++) speech.place(camera, W, H, false, head)
    expect(width.mock.calls).toHaveLength(2)
    expect(rect).not.toHaveBeenCalled()
    expect(style).not.toHaveBeenCalled()
  })

  it('clique no balão chama onClick(key) (o motor foca o agente)', () => {
    const onClick = vi.fn()
    speech = new Speech(host, onClick, seededRng(5))
    heads.set('conv:a', new Vector3(0, 1.2, 0))
    speech.feed(snap([asking('conv:a')]), [], NOW)
    speech.place(camera, W, H, false, head)
    bubble('conv:a').click()
    expect(onClick).toHaveBeenCalledWith('conv:a')
  })

  it('tick sem feed deixa o relógio andar: a fala de progresso expira e o balão sai', () => {
    speech = new Speech(host, () => {}, seededRng(6))
    heads.set('a', new Vector3(0, 1.2, 0))
    expect(speech.tick(NOW)).toBe(false) // sem retrato ainda
    speech.feed(snap([reading('a', 0)]), [], NOW)
    speech.place(camera, W, H, false, head)
    expect(speech.quipOf('a')?.kind).toBe('progress')
    expect(speech.tick(NOW + 1_000)).toBe(false)
    expect(speech.tick(NOW + TTL_MS.progress + 1)).toBe(true)
    expect(speech.quipOf('a')).toBeNull()
    expect(bubble('a').classList.contains('qb-out')).toBe(true)
  })

  it('dispose tira a camada do palco', () => {
    speech = new Speech(host, () => {}, seededRng(7))
    expect(host.querySelector('.qb-layer')).not.toBeNull()
    speech.dispose()
    expect(host.querySelector('.qb-layer')).toBeNull()
  })
})
