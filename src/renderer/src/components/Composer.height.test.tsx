import { createRef } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, afterEach, beforeEach, afterAll } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import { Composer } from './Composer'
import type { EditorElement } from '../inlineMedia/InlineEditor'

/**
 * Altura da caixa do Composer (contenteditable) com as regras REAIS do
 * styles.css: vazia 30px, 1 linha 30px, cada linha +21px até 8 (177px), e
 * dali em diante rola. O jsdom não faz layout: o scrollHeight imita o do
 * Chromium, com QUEBRA AUTOMÁTICA pela largura do campo (CHAR_W px por
 * caractere) além do "\n", e uma linha com emoji 2px mais alta. A largura
 * muda por um ResizeObserver falso, como o do navegador.
 */

const LH = 21
const PAD = 9
const CHAR_W = 7
const TALL = 2
const TOKEN = '\uFFFC'

// As regras do styles.css que entram na conta (copiadas do arquivo, não à mão). O jsdom
// não resolve var() no estilo computado; a variável do padding é trocada pelo valor que
// o próprio arquivo declara em .composer-input-wrap, como o navegador faria.
function composerCss(): string {
  const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
  const block = (sel: string): string => {
    const i = css.indexOf(`${sel} {`)
    return css.slice(i, css.indexOf('}', i) + 1)
  }
  const pad = /--composer-pad-y: ([^;]+);/.exec(block('.composer-input-wrap'))?.[1] ?? 'MISSING'
  return [
    '.composer-input',
    '.composer-input-wrap',
    '.composer-input-wrap .composer-input',
    ".composer-input-wrap .composer-input[role='textbox']"
  ]
    .map(block)
    .join('\n')
    .replaceAll('var(--composer-pad-y)', pad)
}

/** Largura do campo, em px. Muda só por `resize`, como no app. */
let fieldWidth = 600

/** Linhas visuais de um texto na largura atual: cada "\n" abre linha e a linha longa quebra. */
function wrappedHeight(v: string, width: number): number {
  const perLine = Math.max(1, Math.floor(width / CHAR_W))
  let h = 0
  for (const seg of v.split('\n')) {
    h += Math.max(1, Math.ceil([...seg].length / perLine)) * LH
    if (/\p{Extended_Pictographic}/u.test(seg)) h += TALL
  }
  return h
}

// ResizeObserver falso: guarda quem observa o quê; `resize` muda a largura e avisa.
type ROCallback = (entries: Array<{ target: Element; contentRect: { width: number } }>) => void
const observers = new Set<{ cb: ROCallback; targets: Set<Element> }>()
class FakeResizeObserver {
  private rec: { cb: ROCallback; targets: Set<Element> }
  constructor(cb: ROCallback) {
    this.rec = { cb, targets: new Set() }
    observers.add(this.rec)
  }
  observe(el: Element): void {
    this.rec.targets.add(el)
  }
  unobserve(el: Element): void {
    this.rec.targets.delete(el)
  }
  disconnect(): void {
    observers.delete(this.rec)
  }
}
function resize(width: number): void {
  fieldWidth = width
  act(() => {
    for (const o of observers) for (const target of o.targets) o.cb([{ target, contentRect: { width } }])
  })
}

const style = document.createElement('style')
const scrollDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver

beforeEach(() => {
  fieldWidth = 600
  style.textContent = composerCss()
  document.head.appendChild(style)
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.getAttribute('role') !== 'textbox') return 0
      const v = (this as EditorElement).value ?? ''
      return (v === '' ? 0 : wrappedHeight(v, fieldWidth)) + PAD
    }
  })
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver
  Element.prototype.scrollIntoView = vi.fn()
  ;(window as unknown as { api: unknown }).api = { mentionSearch: vi.fn(async () => []), resolvePastedPath: vi.fn(), readFileBytes: vi.fn() }
})
afterEach(() => {
  cleanup()
  style.remove()
  observers.clear()
})
afterAll(() => {
  if (scrollDesc) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollDesc)
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO
})

function setup(disabled = false) {
  const view = render(
    <UiProvider>
      <Composer
        convId="c1"
        draft=""
        disabled={disabled}
        busy={false}
        chips={[]}
        onRemoveChip={() => {}}
        onSend={vi.fn()}
        onInterrupt={() => {}}
        textareaRef={createRef<HTMLElement>()}
        projects={[]}
        projectRoot="C:\proj"
        onDraftChange={vi.fn()}
        projectMissing={false}
        projectMissingMsg=""
      />
    </UiProvider>
  )
  const box = (): EditorElement => screen.getByRole('textbox', { name: 'Mensagem' }) as EditorElement
  const type = (v: string): void => {
    fireEvent.change(box(), { target: { value: v } })
  }
  const lines = (n: number): string => Array.from({ length: n }, (_, i) => `linha ${i + 1}`).join('\n')
  return { box, type, lines, unmount: view.unmount }
}

describe('Composer — altura da caixa por linha', () => {
  it('as regras do styles.css chegam à caixa: linha 1.5 × 14px, 4,5px de padding e o piso calculado deles', () => {
    const { box } = setup()
    const cs = getComputedStyle(box())
    expect(cs.lineHeight).toBe('1.5')
    expect(cs.fontSize).toBe('14px')
    expect(cs.paddingTop).toBe('4.5px')
    expect(cs.paddingBottom).toBe('4.5px')
    expect(cs.minHeight).toBe('calc(1lh + 9px)') // o jsdom simplifica, mas não resolve 1lh
  })

  it('vazia = 30px sem rolar; 1 linha continua 30px', () => {
    const { box, type } = setup()
    expect(box().style.height).toBe('30px')
    expect(box().style.overflowY).toBe('hidden')
    type('linha 1')
    expect(box().style.height).toBe('30px')
  })

  it('vazia e desabilitada (sem sessão) também = 30px', () => {
    const { box } = setup(true)
    expect(box().getAttribute('contenteditable')).toBe('false')
    expect(box().style.height).toBe('30px')
  })

  it('2, 3 e 8 linhas: +21px por linha (51, 72, 177), sem rolar', () => {
    const { box, type, lines } = setup()
    for (const [n, px] of [[2, 51], [3, 72], [8, 177]] as const) {
      type(lines(n))
      expect(box().style.height, `${n} linhas`).toBe(`${px}px`)
      expect(box().style.overflowY).toBe('hidden')
    }
  })

  it('9 e 12 linhas: fica em 177px e rola', () => {
    const { box, type, lines } = setup()
    for (const n of [9, 12]) {
      type(lines(n))
      expect(box().style.height, `${n} linhas`).toBe('177px')
      expect(box().style.overflowY).toBe('auto')
    }
  })

  it('apagar tudo volta a 30px', () => {
    const { box, type, lines } = setup()
    type(lines(12))
    type('')
    expect(box().style.height).toBe('30px')
    expect(box().style.overflowY).toBe('hidden')
  })

  it('anexo inline ocupa um caractere na linha: não soma altura', () => {
    const { box, type } = setup()
    type(`antes ${TOKEN} depois`)
    expect(box().style.height).toBe('30px')
    type(`antes ${TOKEN} depois\nlinha 2`)
    expect(box().style.height).toBe('51px')
  })
})

describe('Composer — quebra automática e mudança de largura', () => {
  const text60 = 'x'.repeat(60) // 1 linha a 600px (85 caracteres), 2 a 300px (42), 3 a 150px (21)

  it('uma linha longa que quebra pela largura cresce como uma 2ª linha, sem nenhum "\\n"', () => {
    fieldWidth = 300
    const { box, type } = setup()
    type(text60)
    expect(box().style.height).toBe('51px')
  })

  it('estreitar o campo sem digitar: a linha que passa a quebrar ganha altura (ResizeObserver)', () => {
    const { box, type } = setup()
    type(text60)
    expect(box().style.height).toBe('30px')
    fieldWidth = 300 // a largura mudou, mas o navegador ainda não avisou: nada muda sozinho
    expect(box().style.height).toBe('30px')
    resize(300)
    expect(box().style.height).toBe('51px')
    expect(box().style.overflowY).toBe('hidden')
    resize(150)
    expect(box().style.height).toBe('72px')
  })

  it('alargar de volta devolve a caixa a 1 linha', () => {
    fieldWidth = 150
    const { box, type } = setup()
    type(text60)
    expect(box().style.height).toBe('72px')
    resize(600)
    expect(box().style.height).toBe('30px')
  })

  it('8 linhas que viram 9+ ao estreitar passam a rolar; ao alargar, param', () => {
    const { box, type, lines } = setup()
    type(`${lines(7)}\n${text60}`)
    expect(box().style.height).toBe('177px')
    expect(box().style.overflowY).toBe('hidden')
    resize(300)
    expect(box().style.height).toBe('177px')
    expect(box().style.overflowY).toBe('auto')
    resize(600)
    expect(box().style.overflowY).toBe('hidden')
  })

  it('vazia em qualquer largura = 30px (o placeholder fica no espelho, fora da medida)', () => {
    const { box } = setup()
    for (const w of [600, 300, 150]) {
      resize(w)
      expect(box().style.height, `${w}px`).toBe('30px')
    }
  })

  it('desmontar desliga o observador', () => {
    const { unmount } = setup()
    expect(observers.size).toBe(1)
    unmount()
    expect(observers.size).toBe(0)
  })
})

describe('Composer — linha mais alta (emoji) no teto', () => {
  it('8 linhas com um emoji não rolam; a 9ª rola', () => {
    const { box, type, lines } = setup()
    type(`${lines(7)}\nfim 😀`)
    expect(box().style.height).toBe(`${177 + TALL}px`)
    expect(box().style.overflowY).toBe('hidden')
    type(`${lines(8)}\nfim 😀`)
    expect(box().style.height).toBe('177px')
    expect(box().style.overflowY).toBe('auto')
  })
})
