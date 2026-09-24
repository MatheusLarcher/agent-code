import { describe, it, expect, afterEach } from 'vitest'
import { absolutizeUrls, buildFlowPdf, pageGeometry, PDF_ANEXOS_CLASS, PDF_MAX_SIDE, PDF_PADDING } from './flowPdf'

afterEach(() => {
  document.body.innerHTML = ''
})

function mountFlow(): HTMLElement {
  document.body.innerHTML = `
    <div class="planning"><main class="pl-stage-area">
      <div class="pl-canvas"><div class="react-flow dark"><div class="react-flow__renderer">
        <div class="react-flow__viewport" style="transform: translate(10px, 20px) scale(0.5)">
          <div class="react-flow__node" data-id="a">Card <b>A</b> &lt;x&gt;</div>
          <div class="react-flow__handle"></div>
        </div>
      </div></div></div>
    </main></div>`
  return document.querySelector('.pl-stage-area') as HTMLElement
}

describe('flowPdf', () => {
  it('a página tem o tamanho dos cards + folga, e encolhe só acima do teto', () => {
    expect(pageGeometry({ x: 0, y: 0, width: 1000, height: 500 })).toEqual({
      width: 1000 + PDF_PADDING * 2,
      height: 500 + PDF_PADDING * 2,
      scale: 1
    })
    const big = pageGeometry({ x: 0, y: 0, width: PDF_MAX_SIDE * 2, height: 100 })
    expect(big.width).toBeLessThanOrEqual(PDF_MAX_SIDE)
    expect(big.scale).toBeLessThan(1)
  })

  it('url() relativo vira absoluto; data:, http e # ficam como estão', () => {
    const base = 'file:///C:/app/out/renderer/assets/index.css'
    expect(absolutizeUrls('src: url("./f.woff2")', base)).toBe('src: url("file:///C:/app/out/renderer/assets/f.woff2")')
    expect(absolutizeUrls('url(data:image/png;base64,AA)', base)).toBe('url(data:image/png;base64,AA)')
    expect(absolutizeUrls("url('https://x.com/a.png')", base)).toBe("url('https://x.com/a.png')")
    expect(absolutizeUrls('url(#grad)', base)).toBe('url(#grad)')
  })

  it('clona o flow inteiro reposicionado, com os ancestrais para o CSS valer', () => {
    const stage = mountFlow()
    const req = buildFlowPdf(stage, { x: 100, y: 50, width: 400, height: 300 }, 'Meu "plano"')!
    expect(req.width).toBe(400 + PDF_PADDING * 2)
    expect(req.height).toBe(300 + PDF_PADDING * 2)
    expect(req.name).toBe('Meu "plano"')
    const page = new DOMParser().parseFromString(req.html, 'text/html')
    const vp = page.querySelector('.planning .pl-canvas .react-flow.dark .react-flow__viewport') as HTMLElement
    expect(vp).not.toBeNull()
    expect(vp.style.transform).toBe(`translate(${PDF_PADDING - 100}px, ${PDF_PADDING - 50}px) scale(1)`)
    expect(vp.querySelector('[data-id="a"]')?.textContent).toBe('Card A <x>')
    expect(page.title).toBe('Meu "plano"')
    expect(req.html).toContain(`@page { size: ${req.width}px ${req.height}px; margin: 0; }`)
    // O canvas da tela continua intacto.
    expect((stage.querySelector('.react-flow__viewport') as HTMLElement).style.transform).toBe('translate(10px, 20px) scale(0.5)')
  })

  /** Um nó como o CardNode desenha: faixa .pl-card-media (até 3 + "+N") abaixo do título. */
  function mountMediaFlow(): Element {
    document.body.innerHTML = `
      <main class="pl-stage-area"><div class="react-flow"><div class="react-flow__viewport">
        <div class="react-flow__node" data-id="tela"><div class="pl-card"><div class="pl-card-inner">
          <div class="pl-card-top">Mídia</div>
          <div class="pl-card-title">Tela de login</div>
          <div class="pl-card-media">
            <img class="pl-media-thumb" src="data:image/png;base64,AAAA" alt="a1-tela.png">
            <span class="pl-media-chip">PDF b2-contrato.pdf</span>
            <span class="pl-media-more">+1</span>
          </div>
          <div class="pl-card-body"><p>corpo</p></div>
        </div></div></div>
        <div class="react-flow__node" data-id="sem"><div class="pl-card-title">Sem anexo</div></div>
      </div></div></main>`
    return document.querySelector('.pl-stage-area')!
  }

  it('lista TODOS os nomes dos anexos no card do PDF, no lugar da faixa de miniaturas; a tela fica intacta', () => {
    const stage = mountMediaFlow()
    const cards = [
      { id: 'tela', anexos: ['a1-tela.png', 'b2-contrato.pdf', 'c3-video.mp4'] },
      { id: 'sem', anexos: [] }
    ]
    const req = buildFlowPdf(stage, { x: 0, y: 0, width: 100, height: 100 }, 'p', cards)!
    const page = new DOMParser().parseFromString(req.html, 'text/html')
    const card = page.querySelector('[data-id="tela"]')!
    const list = card.querySelector(`.${PDF_ANEXOS_CLASS}`)!
    expect(list.textContent).toBe('Anexos: a1-tela.png, b2-contrato.pdf, c3-video.mp4')
    // Logo abaixo do título: a altura do card é limitada, o corpo pode ser cortado.
    expect(list.previousElementSibling?.className).toBe('pl-card-title')
    expect(card.querySelector('.pl-card-media')).toBeNull()
    expect(card.querySelector('img')).toBeNull()
    expect(page.querySelector('[data-id="sem"]')!.querySelector(`.${PDF_ANEXOS_CLASS}`)).toBeNull()
    // O canvas da tela não ganha a lista nem perde a miniatura.
    expect(stage.querySelector(`.${PDF_ANEXOS_CLASS}`)).toBeNull()
    expect(stage.querySelector('img')).not.toBeNull()
  })

  it('sem cards informados: nada de lista, e a miniatura vira o nome dela (imagem não vai ao PDF)', () => {
    const req = buildFlowPdf(mountMediaFlow(), { x: 0, y: 0, width: 10, height: 10 }, 'p')!
    expect(req.html).not.toContain(PDF_ANEXOS_CLASS)
    const page = new DOMParser().parseFromString(req.html, 'text/html')
    expect(page.querySelector('img')).toBeNull()
    expect(page.querySelector('.pl-card-media')?.textContent).toContain('a1-tela.png')
    // Sem mídia nenhuma, o HTML do nó sai igual ao da tela.
    const plain = buildFlowPdf(mountFlow(), { x: 0, y: 0, width: 10, height: 10 }, 'p')!
    expect(plain.html).toContain('Card <b>A</b> &lt;x&gt;')
  })

  it('sem flow montado, não há o que exportar', () => {
    document.body.innerHTML = '<main class="pl-stage-area"></main>'
    expect(buildFlowPdf(document.body.firstElementChild!, { x: 0, y: 0, width: 1, height: 1 }, 'x')).toBeNull()
  })
})
