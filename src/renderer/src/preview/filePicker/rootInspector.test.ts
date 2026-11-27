import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRootInspector, type RootInspector, type RootPick } from './rootInspector'

let root: HTMLDivElement
let layer: HTMLDivElement
let insp: RootInspector
let picks: RootPick[]
let esc: ReturnType<typeof vi.fn<() => void>>

/** Números das marcas desenhadas na camada, em ordem. */
const marks = (): string[] =>
  [...layer.querySelectorAll<HTMLElement>('[data-agent-preview-inspector]')]
    .filter((n) => n.style.display !== 'none' && n.firstElementChild?.textContent && !n.querySelector('div[style*="monospace"]'))
    .map((n) => n.firstElementChild!.textContent!)

const hoverBox = (): HTMLElement | undefined =>
  [...layer.querySelectorAll<HTMLElement>('[data-agent-preview-inspector]')].find((n) =>
    n.querySelector('div[style*="monospace"]')
  )

beforeEach(() => {
  document.body.innerHTML = `
    <div id="outside"><button id="fora">Fora</button></div>
    <div id="host">
      <div id="root"><section class="pv-md"><h1 id="t">Título</h1><p class="lead">Texto</p><button id="next">→</button></section></div>
      <div id="layer"></div>
    </div>`
  root = document.getElementById('root') as HTMLDivElement
  layer = document.getElementById('layer') as HTMLDivElement
  root.tabIndex = -1
  picks = []
  esc = vi.fn<() => void>()
  insp = createRootInspector({ root, layer, onPick: (p) => picks.push(p), onEsc: esc })
})

afterEach(() => {
  insp.destroy()
})

describe('inspetor restrito à raiz (arquivos do Preview)', () => {
  it('hover mostra a caixa com o seletor só dentro da raiz', () => {
    insp.setOn(true)
    document.getElementById('t')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    const box = hoverBox()
    expect(box?.style.display).toBe('block')
    expect(box?.textContent).toBe('#t')
    // As caixas vão para a camada, em absolute (não fixed no <html>).
    expect(box?.style.position).toBe('absolute')
    expect(document.documentElement.querySelectorAll(':scope > [data-agent-preview-inspector]')).toHaveLength(0)
    root.dispatchEvent(new MouseEvent('mouseleave'))
    expect(box?.style.display).toBe('none')
  })

  it('clique marca 1 e 2, manda a captura e não chega ao visualizador', () => {
    const viewerClick = vi.fn()
    const viewerDown = vi.fn()
    document.getElementById('next')!.addEventListener('click', viewerClick)
    document.getElementById('next')!.addEventListener('mousedown', viewerDown)
    insp.setOn(true)
    expect(root.hasAttribute('data-pv-picking')).toBe(true)
    expect(document.activeElement).toBe(root)
    document.getElementById('t')!.click()
    document.getElementById('next')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    document.getElementById('next')!.click()
    expect(viewerClick).not.toHaveBeenCalled()
    expect(viewerDown).not.toHaveBeenCalled()
    expect(picks).toEqual([
      expect.objectContaining({ tagName: 'h1', selector: '#t', text: 'Título', index: 1 }),
      expect.objectContaining({ tagName: 'button', selector: '#next', index: 2 })
    ])
    // Mesmo elemento de novo: já marcado, não repete.
    document.getElementById('t')!.click()
    expect(picks).toHaveLength(2)
    expect(marks()).toEqual(['1', '2'])
  })

  it('teclas não chegam ao visualizador; Esc só desliga o modo e as marcas ficam', () => {
    const viewerKey = vi.fn()
    root.addEventListener('keydown', viewerKey)
    insp.setOn(true)
    document.getElementById('t')!.click()
    document.getElementById('next')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(viewerKey).not.toHaveBeenCalled()
    document.getElementById('next')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(insp.isOn()).toBe(false)
    expect(esc).toHaveBeenCalledTimes(1)
    expect(root.hasAttribute('data-pv-picking')).toBe(false)
    expect(marks()).toEqual(['1'])
    // Desligado: tudo volta ao normal.
    const viewerClick = vi.fn()
    document.getElementById('next')!.addEventListener('click', viewerClick)
    document.getElementById('next')!.click()
    document.getElementById('next')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(viewerClick).toHaveBeenCalledTimes(1)
    expect(viewerKey).toHaveBeenCalledTimes(1)
    expect(picks).toHaveLength(1)
  })

  it('sync fica só com os seletores do campo de mensagem, renumerando', () => {
    insp.setOn(true)
    document.getElementById('t')!.click()
    root.querySelector<HTMLElement>('p.lead')!.click()
    const [a, b] = picks.map((p) => p.selector)
    insp.setOn(false)
    expect(marks()).toEqual(['1', '2'])
    insp.sync([b])
    expect(marks()).toEqual(['1'])
    // A próxima marca segue depois da maior que restou.
    insp.setOn(true)
    document.getElementById('next')!.click()
    expect(picks.at(-1)?.index).toBe(2)
    insp.sync([])
    expect(marks()).toEqual([])
    expect(a).not.toBe(b)
  })

  it('sync com número: a marca usa o "[elemento N]" global do campo, não a posição na aba', () => {
    insp.setOn(true)
    document.getElementById('t')!.click()
    root.querySelector<HTMLElement>('p.lead')!.click()
    const [a, b] = picks.map((p) => p.selector)
    // No campo: [elemento 1] veio de outra aba, [elemento 2] = b, [elemento 3] = a.
    insp.sync([
      { selector: b, n: 2 },
      { selector: a, n: 3 }
    ])
    expect(marks().sort()).toEqual(['2', '3'])
    insp.sync([{ selector: b, n: 1 }])
    expect(marks()).toEqual(['1'])
    // A próxima segue depois da maior que restou.
    document.getElementById('next')!.click()
    expect(picks.at(-1)?.index).toBe(2)
  })

  it('elemento que sai do DOM (outro slide) perde a marca sem precisar rolar', async () => {
    insp.setOn(true)
    document.getElementById('t')!.click()
    expect(marks()).toEqual(['1'])
    document.getElementById('t')!.remove()
    await new Promise((r) => setTimeout(r, 0))
    expect(marks()).toEqual([])
  })

  it('clique fora da raiz é ignorado e segue normal', () => {
    const outsideClick = vi.fn()
    document.getElementById('fora')!.addEventListener('click', outsideClick)
    insp.setOn(true)
    document.getElementById('fora')!.click()
    expect(outsideClick).toHaveBeenCalledTimes(1)
    expect(picks).toHaveLength(0)
    // A própria raiz (área vazia) também não vira seleção.
    root.click()
    expect(picks).toHaveLength(0)
  })

  it('marcas seguem a rolagem: posição relativa à camada, recalculada no scroll', () => {
    const t = document.getElementById('t')!
    let top = 100
    t.getBoundingClientRect = () => ({ left: 30, top, width: 50, height: 20, right: 80, bottom: top + 20, x: 30, y: top, toJSON: () => ({}) })
    layer.getBoundingClientRect = () => ({ left: 10, top: 40, width: 400, height: 300, right: 410, bottom: 340, x: 10, y: 40, toJSON: () => ({}) })
    insp.setOn(true)
    t.click()
    const badge = [...layer.querySelectorAll<HTMLElement>('[data-agent-preview-inspector]')].find((n) => n.firstElementChild?.textContent === '1')!
    expect([badge.style.left, badge.style.top]).toEqual(['20px', '60px'])
    top = 20
    root.dispatchEvent(new Event('scroll'))
    expect(badge.style.top).toBe('-20px')
  })
})
