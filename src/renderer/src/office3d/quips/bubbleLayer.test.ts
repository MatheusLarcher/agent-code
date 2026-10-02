import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBubbleLayer, EXIT_MS, FONT_PX, SCALE_MAX, type BubbleLayer, type BubbleStack } from './bubbleLayer'
import type { Quip, QuipKind } from './generator'

const quip = (text: string, kind: QuipKind = 'progress', icon = '📖'): Quip => ({ text, kind, icon, priority: 20, ttlMs: 6_000, convId: 'a' })
const animationEnd = (name: string): Event => {
  const e = new Event('animationend', { bubbles: true })
  Object.defineProperty(e, 'animationName', { value: name })
  return e
}
const bubbles = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.qb')]
const shown = (host: HTMLElement): HTMLElement[] => bubbles(host).filter((el) => !el.hidden)

let host: HTMLDivElement
let layer: BubbleLayer | null = null

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
})
afterEach(() => {
  layer?.dispose()
  layer = null
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createBubbleLayer', () => {
  it('set: um balão por agente com texto, ícone e kind; o mesmo Quip não toca no DOM', () => {
    layer = createBubbleLayer(host, { onClick: () => {} })
    const a = quip('Lendo api.ts… quem escreveu isso? Ah, fui eu.')
    expect(layer.set('conv:a', a)).toBe(true)
    const [el] = bubbles(host)
    expect(host.querySelector('.qb-layer')?.contains(el)).toBe(true)
    expect(el.dataset).toMatchObject({ kind: 'progress', key: 'conv:a' })
    expect(el.querySelector('.qb-text')?.textContent).toBe(a.text)
    expect(el.querySelector('.qb-icon')?.textContent).toBe('📖')
    expect(el.getAttribute('role')).toBe('button')
    expect(el.style.opacity).toBe('0') // invisível até o primeiro place
    const mo = new MutationObserver(() => {})
    mo.observe(host, { subtree: true, childList: true, attributes: true, characterData: true })
    expect(layer.set('conv:a', a)).toBe(false)
    expect(layer.set('ninguem', null)).toBe(false)
    expect(mo.takeRecords()).toHaveLength(0)
    mo.disconnect()
    layer.set('conv:b', quip('Rodando npm test. Dedos cruzados 🤞', 'progress', '🧪'))
    expect(shown(host)).toHaveLength(2)
    // Fala nova no mesmo agente: mesmo elemento, kind novo e o pop de novo (qb-alt).
    expect(layer.set('conv:a', quip('Deu ruim: ENOENT config.json. Bora investigar? 🔍', 'error', '💥'))).toBe(true)
    expect(bubbles(host)).toHaveLength(2)
    expect(el.dataset.kind).toBe('error')
    expect(el.classList.contains('qb-alt')).toBe(true)
  })

  it('place: só transform/opacity, só quando muda, sem ler layout', () => {
    layer = createBubbleLayer(host, { onClick: () => {} })
    layer.set('k', quip('oi'))
    const [el] = bubbles(host)
    const reads = [
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect'),
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get'),
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get'),
      vi.spyOn(window, 'getComputedStyle')
    ]
    // Conta cada escrita no style do balão (o jsdom não acusa escrita de valor igual).
    const real = el.style
    const writes: string[] = []
    const counted = new Proxy(real, { set: (t, p, v) => (writes.push(String(p)), Reflect.set(t, p, v)) })
    Object.defineProperty(el, 'style', { configurable: true, get: () => counted })
    layer.place('k', 100.4, 50.6, 1, true)
    expect(el.style.transform).toBe('translate3d(100px, 51px, 0) scale(1) translate(-50%, -100%)')
    expect(el.style.opacity).toBe('')
    expect(writes.sort()).toEqual(['opacity', 'pointerEvents', 'transform'])
    writes.length = 0
    for (let i = 0; i < 200; i++) layer.place('k', 100.2, 50.9, 1.001, true) // mesmo px e escala
    layer.place('sem-balao', 1, 2, 1, true)
    expect(writes).toEqual([])
    layer.place('k', 100.2, 52, 1, true) // só o transform muda
    expect(writes).toEqual(['transform'])
    layer.place('k', 120, 60, 9, true)
    expect(el.style.transform).toBe(`translate3d(120px, 60px, 0) scale(${SCALE_MAX}) translate(-50%, -100%)`)
    layer.place('k', 120, 60, 1, false)
    expect([el.style.opacity, el.style.pointerEvents]).toEqual(['0', 'none'])
    layer.place('k', 130, 70, 1, true)
    expect([el.style.opacity, el.style.pointerEvents]).toEqual(['', ''])
    layer.place('k', Number.NaN, 70, 1, true) // fora da tela/atrás da câmera
    expect(el.style.opacity).toBe('0')
    for (const spy of reads) expect(spy).not.toHaveBeenCalled()
    const inline = Array.from({ length: el.style.length }, (_, i) => el.style.item(i)).sort()
    expect(inline).toEqual(['opacity', 'pointer-events', 'transform'])
  })

  it('null anima a saída e devolve ao pool; o próximo balão reaproveita o elemento', () => {
    vi.useFakeTimers()
    layer = createBubbleLayer(host, { onClick: () => {} })
    layer.set('a', quip('um'))
    const [el] = bubbles(host)
    layer.place('a', 10, 10, 1, true)
    expect(layer.set('a', null)).toBe(true)
    expect(el.classList.contains('qb-out')).toBe(true)
    expect(el.hidden).toBe(false) // ainda sumindo
    layer.place('a', 12, 10, 1, true) // segue a cabeça durante a saída
    expect(el.style.transform).toContain('translate3d(12px, 10px, 0)')
    vi.advanceTimersByTime(EXIT_MS)
    expect(el.hidden).toBe(true)
    expect(el.classList.contains('qb-out')).toBe(false)
    // Outro agente reaproveita o mesmo elemento, invisível até ser posicionado.
    layer.set('b', quip('dois'))
    expect(bubbles(host)).toEqual([el])
    expect([el.hidden, el.dataset.key, el.style.opacity]).toEqual([false, 'b', '0'])
    // animationend da saída também devolve, sem esperar o timer.
    layer.set('b', null)
    el.querySelector('.qb-body')?.dispatchEvent(animationEnd('qb-pop'))
    expect(el.hidden).toBe(false)
    el.querySelector('.qb-body')?.dispatchEvent(animationEnd('qb-out'))
    expect(el.hidden).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    // O pool cresce até o máximo simultâneo e para.
    for (const k of ['1', '2', '3']) layer.set(k, quip(k))
    for (const k of ['1', '2', '3']) layer.set(k, null)
    vi.advanceTimersByTime(EXIT_MS)
    for (const k of ['4', '5', '6']) layer.set(k, quip(k))
    expect(bubbles(host)).toHaveLength(3)
    expect(shown(host)).toHaveLength(3)
  })

  it('set durante a saída reaproveita o mesmo elemento, sem piscar', () => {
    vi.useFakeTimers()
    layer = createBubbleLayer(host, { onClick: () => {} })
    layer.set('a', quip('um'))
    layer.place('a', 10, 10, 1, true)
    const [el] = bubbles(host)
    layer.set('a', null)
    layer.set('a', quip('de novo'))
    expect(el.classList.contains('qb-out')).toBe(false)
    expect(el.style.opacity).toBe('')
    vi.advanceTimersByTime(EXIT_MS * 2)
    expect(el.hidden).toBe(false)
    expect(bubbles(host)).toEqual([el])
    expect(el.querySelector('.qb-text')?.textContent).toBe('de novo')
  })

  it('clique e Enter chamam onClick(key); balão saindo não', () => {
    const onClick = vi.fn()
    layer = createBubbleLayer(host, { onClick })
    layer.set('conv:a', quip('Posso rodar `rm -rf dist`? Clica em mim 🙋', 'permission', '✋'))
    const [el] = bubbles(host)
    ;(el.querySelector('.qb-text') as HTMLElement).click()
    expect(onClick).toHaveBeenCalledWith('conv:a')
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(onClick).toHaveBeenCalledTimes(3)
    ;(host.querySelector('.qb-layer') as HTMLElement).click()
    layer.set('conv:a', null)
    el.click()
    expect(onClick).toHaveBeenCalledTimes(3)
  })

  it('compact: zoom longe deixa só o ícone (classe na camada), sem tocar nos balões', () => {
    layer = createBubbleLayer(host, { onClick: () => {} })
    layer.set('a', quip('Posso rodar `rm -rf dist`?', 'permission', '✋'))
    const root = host.querySelector('.qb-layer') as HTMLElement
    layer.compact(true)
    expect(root.classList.contains('qb-compact')).toBe(true)
    expect(bubbles(host)[0].querySelector('.qb-icon')?.textContent).toBe('✋')
    layer.compact(false)
    expect(root.classList.contains('qb-compact')).toBe(false)
  })

  it('size: mede o balão inteiro no set (uma leitura, no medidor, mesmo com a camada compacta); sem layout, estima', () => {
    layer = createBubbleLayer(host, { onClick: () => {} })
    const out = { w: 0, h: 0 }
    expect(layer.size('k', out)).toBe(false)
    // jsdom não tem layout (0 px): estimativa pelo texto, até o max-width do .qb-body.
    layer.set('k', quip('oi'))
    expect(layer.size('k', out)).toBe(true)
    const small = { ...out }
    layer.set('k', quip('Lendo src/renderer/src/office3d/quips/bubbleLayer.ts inteirinho, linha por linha.'))
    layer.size('k', out)
    expect(out.w).toBeGreaterThan(small.w)
    expect(out.w).toBeLessThanOrEqual(220)
    expect(out.h).toBeGreaterThan(small.h)
    // Com layout: o tamanho vem do medidor — fora das regras de compacto e dos cliques.
    const onMeter = (n: number) =>
      function (this: HTMLElement): number {
        return this.classList.contains('qb-measure') ? n : 0
      }
    const w = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(onMeter(180))
    const h = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(onMeter(52))
    layer.compact(true)
    layer.set('k', quip('Posso rodar `rm -rf dist`? Clica em mim 🙋', 'permission', '✋'))
    expect(layer.size('k', out)).toBe(true)
    expect(out).toEqual({ w: 180, h: 52 })
    expect([w.mock.calls.length, h.mock.calls.length]).toEqual([1, 1])
    const meter = host.querySelector<HTMLElement>('.qb-measure')!
    expect([meter.classList.contains('qb'), meter.getAttribute('aria-hidden'), meter.dataset.kind]).toEqual([false, 'true', 'permission'])
    expect(bubbles(host)).toHaveLength(1)
    // Mesma fala de novo (outra identidade, mesmo texto) e 50 quadros: nenhuma leitura a mais.
    layer.set('k', quip('Posso rodar `rm -rf dist`? Clica em mim 🙋', 'permission', '✋'))
    for (let i = 0; i < 50; i++) layer.place('k', 100 + i, 100, 1, true)
    expect([w.mock.calls.length, h.mock.calls.length]).toEqual([1, 1])
  })

  it('place com stack: ícone compacto por balão, andar atrás dos da cabeça e linha-guia até (lx, ly); só escreve quando muda', () => {
    vi.useFakeTimers()
    layer = createBubbleLayer(host, { onClick: () => {} })
    layer.set('k', quip('oi'))
    const [el] = bubbles(host)
    const lead = el.querySelector<HTMLElement>('.qb-lead')!
    const has = (c: string): boolean => el.classList.contains(c)
    const stack: BubbleStack = { compact: false, lift: 0, lx: 0, ly: 0 }
    layer.place('k', 100, 200, 1, true, stack)
    expect([has('qb-up1'), has('qb-up2'), has('qb-compact'), lead.style.transform]).toEqual([false, false, false, ''])
    // Subiu 1 andar: classe do andar e a linha-guia da ponta (100, 200) até (100, 260), reta para baixo.
    Object.assign(stack, { lift: 1, lx: 100, ly: 260 })
    layer.place('k', 100, 200, 1, true, stack)
    expect(has('qb-up1')).toBe(true)
    expect(lead.style.transform).toBe('rotate(0rad) scaleY(60)')
    // Na escala 0,8 o comprimento é no espaço do balão (÷ 0,8); cabeça ao lado: a linha gira.
    Object.assign(stack, { lift: 2, lx: 160, ly: 260 })
    layer.place('k', 100, 200, 0.8, true, stack)
    expect([has('qb-up1'), has('qb-up2')]).toEqual([false, true])
    expect(lead.style.transform).toBe('rotate(-0.79rad) scaleY(106)')
    // Mesmo lugar: nenhuma escrita (nem classe, nem estilo da linha).
    const toggle = vi.spyOn(DOMTokenList.prototype, 'toggle')
    const writes: string[] = []
    const real = lead.style
    const counted = new Proxy(real, { set: (t, p, v) => (writes.push(String(p)), Reflect.set(t, p, v)) })
    Object.defineProperty(lead, 'style', { configurable: true, get: () => counted })
    for (let i = 0; i < 100; i++) layer.place('k', 100.2, 199.8, 0.801, true, stack)
    expect(toggle).not.toHaveBeenCalled()
    expect(writes).toEqual([])
    // Ícone compacto por balão, sem mexer na camada; sem stack, volta ao balão inteiro na cabeça.
    Object.assign(stack, { compact: true, lift: 0 })
    layer.place('k', 100, 200, 1, true, stack)
    expect([has('qb-compact'), has('qb-up2')]).toEqual([true, false])
    expect(host.querySelector('.qb-layer')!.classList.contains('qb-compact')).toBe(false)
    layer.place('k', 100, 200, 1, true)
    expect(has('qb-compact')).toBe(false)
    // Invisível não troca classe; o elemento volta ao pool limpo.
    Object.assign(stack, { compact: true, lift: 2 })
    layer.place('k', 100, 200, 1, false, stack)
    expect([has('qb-compact'), has('qb-up2')]).toEqual([false, false])
    layer.place('k', 100, 200, 1, true, stack)
    layer.set('k', null)
    vi.advanceTimersByTime(EXIT_MS)
    expect(['qb-compact', 'qb-up1', 'qb-up2'].some(has)).toBe(false)
  })

  it('FONT_PX é a fonte do .qb-body no quips.css (o motor garante a fonte mínima com ela)', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/office3d/quips/quips.css'), 'utf8')
    const body = /\n\.qb-body \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(Number(/font:\s*\d+\s+(\d+)px/.exec(body)?.[1])).toBe(FONT_PX)
  })

  it('dispose: tira a camada, cancela timers e remove cada listener que pôs', () => {
    vi.useFakeTimers()
    const add = vi.spyOn(EventTarget.prototype, 'addEventListener')
    const remove = vi.spyOn(EventTarget.prototype, 'removeEventListener')
    const onClick = vi.fn()
    const l = createBubbleLayer(host, { onClick })
    l.set('a', quip('um'))
    l.set('b', quip('dois'))
    l.set('b', null) // saindo, com timer
    expect(vi.getTimerCount()).toBe(1)
    const [el] = bubbles(host)
    l.dispose()
    const calls = (spy: typeof add): Array<[unknown, unknown, unknown]> => spy.mock.calls.map((c, i) => [spy.mock.contexts[i], c[0], c[1]])
    expect(add).toHaveBeenCalledTimes(3)
    expect(calls(remove)).toEqual(calls(add))
    expect(host.childElementCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(l.set('c', quip('três'))).toBe(false)
    l.place('a', 1, 1, 1, true)
    l.dispose()
    el.click()
    expect(onClick).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledTimes(3)
  })
})
