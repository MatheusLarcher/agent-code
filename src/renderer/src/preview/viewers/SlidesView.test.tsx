import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PreviewFileOk, PreviewParagraph, PreviewSlide } from '@shared/preview'
import { SlidesView, chooseFit } from './SlidesView'
import { FileViewer } from './FileViewer'

afterEach(cleanup)

type Slides = Extract<PreviewFileOk, { kind: 'slides' }>

const text = (t: string, extra: Partial<PreviewSlide> = {}): PreviewSlide => ({
  shapes: [
    {
      type: 'box',
      x: 0.1,
      y: 0.2,
      w: 0.5,
      h: 0.25,
      fill: '#ff0000',
      text: { anchor: 'middle', pad: [0, 0, 0, 0], paragraphs: [{ runs: [{ text: t, size: 44, bold: true, color: '#00ff00' }], align: 'center' }] }
    }
  ],
  ...extra
})

const deck = (slides: PreviewSlide[], extra: Partial<Slides> = {}): Slides => ({
  ok: true,
  kind: 'slides',
  path: 'C:\\x\\deck.pptx',
  width: 12192000,
  height: 6858000,
  slides,
  images: {},
  truncated: false,
  ...extra
})

const stage = (c: HTMLElement): HTMLElement => c.querySelector('.pv-sl-main') as HTMLElement

describe('SlidesView', () => {
  it('desenha o slide 1 com posição em % e fonte em cqw, e o contador', () => {
    const { container } = render(<SlidesView result={deck([text('Olá'), text('Dois')])} />)
    expect(screen.getByText('Slide 1 de 2')).toBeTruthy()
    const shape = stage(container).querySelector('.pv-sl-shape') as HTMLElement
    expect(shape.style.left).toBe('10%')
    expect(shape.style.width).toBe('50%')
    expect(shape.style.background).toContain('rgb(255, 0, 0)')
    const run = stage(container).querySelector('.pv-sl-p span') as HTMLElement
    expect(run.textContent).toBe('Olá')
    // 44 pt × 12700 / 12192000 × 100 = 4.5833cqw
    expect(run.style.fontSize).toBe('4.5833cqw')
    expect(run.style.fontWeight).toBe('700')
    expect(stage(container).querySelector('.pv-sl-text.middle')).toBeTruthy()
  })

  it('navega por botão, teclado e miniatura', () => {
    const { container } = render(<SlidesView result={deck([text('A'), text('B'), text('C')])} />)
    const prev = screen.getByRole('button', { name: /Anterior/ }) as HTMLButtonElement
    const next = screen.getByRole('button', { name: /Próxima/ }) as HTMLButtonElement
    expect(prev.disabled).toBe(true)
    fireEvent.click(next)
    expect(screen.getByText('Slide 2 de 3')).toBeTruthy()
    expect(stage(container).textContent).toBe('B')
    const root = container.querySelector('.pv-slides') as HTMLElement
    fireEvent.keyDown(root, { key: 'End' })
    expect(screen.getByText('Slide 3 de 3')).toBeTruthy()
    expect(next.disabled).toBe(true)
    fireEvent.keyDown(root, { key: 'ArrowRight' })
    expect(screen.getByText('Slide 3 de 3')).toBeTruthy()
    fireEvent.keyDown(root, { key: 'PageUp' })
    expect(screen.getByText('Slide 2 de 3')).toBeTruthy()
    fireEvent.keyDown(root, { key: 'Home' })
    expect(stage(container).textContent).toBe('A')
    fireEvent.click(screen.getByRole('button', { name: 'Ir para o slide 3' }))
    expect(stage(container).textContent).toBe('C')
    expect(screen.getByRole('button', { name: 'Ir para o slide 3' }).getAttribute('aria-current')).toBe('true')
    // Dicas por data-tip, nunca title.
    expect(next.getAttribute('data-tip')).toBeTruthy()
    expect(container.querySelector('[title]')).toBeNull()
  })

  it('anotações, selo de oculto e aviso de corte', () => {
    render(<SlidesView result={deck([text('A', { notes: ' Falar devagar ', hidden: true }), text('B')], { truncated: true })} />)
    expect(screen.getByText('Falar devagar')).toBeTruthy()
    expect(screen.getByText('Oculto')).toBeTruthy()
    expect(screen.getByText(/primeiros 300 slides/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ir para o slide 1 (oculto)' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Próxima/ }))
    expect(screen.queryByText('Oculto')).toBeNull()
    expect(screen.queryByText('Falar devagar')).toBeNull()
  })

  it('imagem só por data URL; marcador do que não desenha; fundo; tabela; linha', () => {
    const slide: PreviewSlide = {
      background: '#0a0a0a',
      backgroundImage: 'bg',
      shapes: [
        { type: 'image', image: 'img1', x: 0, y: 0, w: 0.5, h: 0.5, flipH: true },
        { type: 'image', image: 'mal', x: 0, y: 0, w: 0.1, h: 0.1 },
        { type: 'missing', label: 'Gráfico', x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
        { type: 'table', rows: [['a', 'b'], ['1', '2']], x: 0, y: 0.6, w: 0.4, h: 0.2, size: 12 },
        { type: 'line', line: '#123456', lineW: 0.002, x: 0, y: 0.9, w: 1, h: 0 },
        { type: 'box', x: Number.NaN, y: 0, w: 1, h: 1, text: { anchor: 'top', pad: [0, 0, 0, 0], paragraphs: [{ runs: [{ text: 'quebrado' }] }] } }
      ]
    }
    const images = { img1: 'data:image/png;base64,iVBORw==', mal: 'file:///C:/segredo.png', bg: 'data:image/jpeg;base64,/9j/' }
    const { container } = render(<SlidesView result={deck([slide], { images })} />)
    const imgs = stage(container).querySelectorAll('img')
    expect(imgs).toHaveLength(1)
    expect(imgs[0].getAttribute('src')).toBe(images.img1)
    expect(imgs[0].style.transform).toBe('scale(-1, 1)')
    expect(stage(container).querySelectorAll('.pv-sl-missing')).toHaveLength(2)
    expect(screen.getByText('Gráfico')).toBeTruthy()
    expect(Array.from(stage(container).querySelectorAll('td')).map((td) => td.textContent)).toEqual(['a', 'b', '1', '2'])
    expect(stage(container).querySelector('line')?.getAttribute('stroke')).toBe('#123456')
    expect(screen.queryByText('quebrado')).toBeNull()
    const canvas = stage(container).querySelector('.pv-sl-canvas') as HTMLElement
    expect(canvas.style.backgroundColor).toBe('rgb(10, 10, 10)')
    expect(canvas.style.backgroundImage).toContain('data:image/jpeg')
    // Um slide só: sem faixa de miniaturas.
    expect(container.querySelector('.pv-sl-strip')).toBeNull()
  })

  it('entrelinha, espaço antes/depois, espaçamento entre letras e wrap="none"; valor inválido é ignorado', () => {
    const box = (paragraphs: PreviewParagraph[], noWrap?: boolean): PreviewSlide['shapes'][number] => ({
      type: 'box', x: 0, y: 0, w: 0.1, h: 0.1, text: { anchor: 'top', pad: [0, 0, 0, 0], paragraphs, ...(noWrap ? { noWrap } : {}) }
    })
    const slide: PreviewSlide = {
      shapes: [
        box([{ runs: [{ text: 'ARC', size: 42, spacing: -1.26 }], lineH: 0.85669, before: 6, after: 12 }], true),
        box([{ runs: [{ text: 'pts', spacing: Number.NaN }], linePt: 30, lineH: 2, before: -5 }]),
        box([{ runs: [{ text: 'ruim' }], lineH: Number.POSITIVE_INFINITY }])
      ]
    }
    const { container } = render(<SlidesView result={deck([slide])} />)
    const [p1, p2, p3] = Array.from(stage(container).querySelectorAll('.pv-sl-p')) as HTMLElement[]
    // 85,669% do espaçamento simples (1,2 × fonte).
    expect(Number(p1.style.lineHeight)).toBeCloseTo(1.028, 4)
    // pt → cqw na escala do slide (o DOM tira os zeros finais).
    const cqw = (v: string, pt: number): void => {
      expect(v.endsWith('cqw')).toBe(true)
      expect(parseFloat(v)).toBeCloseTo(((pt * 12700) / 12192000) * 100, 4)
    }
    cqw(p1.style.marginTop, 6)
    cqw(p1.style.marginBottom, 12)
    // -1,26 pt na mesma escala da fonte.
    cqw((p1.querySelector('span') as HTMLElement).style.letterSpacing, -1.26)
    expect(p1.closest('.pv-sl-text')?.classList.contains('nowrap')).toBe(true)
    // spcPts vence a fração; espaço negativo e NaN não viram estilo.
    cqw(p2.style.lineHeight, 30)
    expect(p2.style.marginTop).toBe('')
    expect((p2.querySelector('span') as HTMLElement).style.letterSpacing).toBe('')
    expect(p2.closest('.pv-sl-text')?.classList.contains('nowrap')).toBe(false)
    expect(p3.style.lineHeight).toBe('')
  })

  it('chooseFit: maior escala que cabe, entre 25% e 100%', () => {
    expect(chooseFit(() => true)).toBe(1)
    expect(chooseFit(() => false)).toBe(0.25)
    const f = chooseFit((s) => s <= 0.6)
    expect(f).toBeLessThanOrEqual(0.6)
    expect(f).toBeGreaterThan(0.59)
    // Mede poucas vezes (1 + mínimo + passos), sem laço.
    let calls = 0
    chooseFit((s) => (calls++, s <= 0.4))
    expect(calls).toBe(9)
  })

  it('normAutofit: encolhe a fonte da caixa até caber (scrollHeight simulado); caixa sem autofit fica igual', () => {
    const proto = HTMLElement.prototype
    const saved = ['scrollHeight', 'clientHeight'].map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const)
    // O texto ocupa 200 px × escala; a caixa tem 100 px.
    Object.defineProperty(proto, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return 200 * Number(this.style.getPropertyValue('--pv-fit') || 1)
      }
    })
    Object.defineProperty(proto, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('pv-sl-text') ? 100 : 0
      }
    })
    try {
      const box = (t: string, autofit: boolean): PreviewSlide['shapes'][number] => ({
        type: 'box', x: 0, y: 0, w: 0.5, h: 0.2, text: { anchor: 'top', pad: [0, 0, 0, 0], paragraphs: [{ runs: [{ text: t, size: 99 }] }], ...(autofit ? { autofit } : {}) }
      })
      const { container } = render(<SlidesView result={deck([{ shapes: [box('Título', true), box('Fixo', false)] }])} />)
      const [fit, fixed] = Array.from(stage(container).querySelectorAll('.pv-sl-text')) as HTMLElement[]
      const scale = Number(fit.style.getPropertyValue('--pv-fit'))
      expect(scale).toBeGreaterThan(0.49)
      expect(scale).toBeLessThanOrEqual(0.505)
      // A fonte da caixa multiplica pela variável; a outra caixa não tem variável nem calc.
      expect(fit.querySelector('span')?.getAttribute('style')).toContain('var(--pv-fit, 1)')
      expect(fixed.style.getPropertyValue('--pv-fit')).toBe('')
      expect(fixed.querySelector('span')?.getAttribute('style')).not.toContain('--pv-fit')
    } finally {
      for (const [k, d] of saved) {
        if (d) Object.defineProperty(proto, k, d)
        else delete (proto as unknown as Record<string, unknown>)[k]
      }
    }
  })

  it('apresentação vazia mostra aviso; FileViewer escolhe os slides', () => {
    render(<SlidesView result={deck([])} />)
    expect(screen.getByText('Esta apresentação não tem slides.')).toBeTruthy()
    cleanup()
    const { container } = render(<FileViewer result={deck([text('Via FileViewer')])} />)
    expect(container.querySelector('.pv-viewer[data-kind="slides"] .pv-slides')).toBeTruthy()
    expect(screen.getByText('Via FileViewer')).toBeTruthy()
  })
})
