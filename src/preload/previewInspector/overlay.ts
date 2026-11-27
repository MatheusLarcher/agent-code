/**
 * Camada visual do seletor (porte do inspector-overlay do Nexos): uma caixa
 * azul segue o mouse com a etiqueta do elemento, e cada clique deixa uma marca
 * laranja numerada (1, 2, 3…) que acompanha o elemento no scroll/resize.
 *
 * Tudo é position:fixed, pointer-events:none e z-index máximo, anexado ao
 * <html> — não mexe no layout nem rouba clique da página.
 *
 * Com `layer` (o seletor dos arquivos dentro do app), as caixas vão para essa
 * camada em position:absolute, com coordenadas relativas a ela: a camada
 * recorta as marcas pela área do visualizador e nada passa por cima do resto.
 */

const Z = '2147483647'
const HOVER = '#4f9dff'
const BADGE = '#d97757'

export interface Overlay {
  showHover(el: Element, label: string): void
  hideHover(): void
  isMarked(el: Element): boolean
  /** Marca o elemento e devolve o número (1-based); null se já estava marcado. */
  mark(el: Element): number | null
  unmark(el: Element): void
  /** Reposiciona as marcas (scroll/resize). */
  reposition(): void
  /** Remove todas as marcas e zera a numeração. */
  clear(): void
  /**
   * Fica só com as marcas para as quais `numberOf` devolve um número (e mostra
   * esse número); as outras saem. A próxima marca segue depois da maior.
   */
  retain(numberOf: (el: Element) => number | null): void
  /** Remove tudo do DOM (marcas e caixa do hover). */
  destroy(): void
}

export interface OverlayOptions {
  /** Camada onde as caixas são desenhadas (relativas a ela). Sem ela: fixed no <html>. */
  layer?: HTMLElement
}

interface Badge {
  el: Element
  box: HTMLDivElement
}

/** Retângulo do elemento no sistema de coordenadas da camada (ou da janela). */
function rectIn(el: Element, layer?: HTMLElement): { left: number; top: number; width: number; height: number } {
  const r = el.getBoundingClientRect()
  if (!layer) return r
  const o = layer.getBoundingClientRect()
  return { left: r.left - o.left, top: r.top - o.top, width: r.width, height: r.height }
}

function place(box: HTMLElement, el: Element, layer?: HTMLElement): void {
  const r = rectIn(el, layer)
  box.style.left = `${r.left}px`
  box.style.top = `${r.top}px`
  box.style.width = `${r.width}px`
  box.style.height = `${r.height}px`
}

function baseBox(doc: Document, border: string, bg: string, inLayer: boolean): HTMLDivElement {
  const box = doc.createElement('div')
  box.setAttribute('data-agent-preview-inspector', '')
  Object.assign(box.style, {
    position: inLayer ? 'absolute' : 'fixed',
    pointerEvents: 'none',
    zIndex: inLayer ? '1' : Z,
    boxSizing: 'border-box',
    border: `2px solid ${border}`,
    background: bg,
    borderRadius: '2px'
  })
  return box
}

export function createOverlay(doc: Document = document, opts: OverlayOptions = {}): Overlay {
  const layer = opts.layer
  let hover: HTMLDivElement | null = null
  let hoverLabel: HTMLDivElement | null = null
  let badges: Badge[] = []
  let next = 1

  const root = (): Element => layer ?? doc.documentElement

  function ensureHover(): HTMLDivElement {
    if (hover && hover.isConnected) return hover
    hover = baseBox(doc, HOVER, 'rgba(79,157,255,.12)', !!layer)
    hoverLabel = doc.createElement('div')
    Object.assign(hoverLabel.style, {
      position: 'absolute',
      top: '-20px',
      left: '-2px',
      background: HOVER,
      color: '#fff',
      font: '11px/16px ui-monospace, Consolas, monospace',
      padding: '1px 5px',
      borderRadius: '3px',
      whiteSpace: 'nowrap',
      maxWidth: '360px',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    })
    hover.appendChild(hoverLabel)
    root().appendChild(hover)
    return hover
  }

  return {
    showHover(el, label) {
      const box = ensureHover()
      place(box, el, layer)
      if (hoverLabel) {
        hoverLabel.textContent = label
        // Sem espaço acima (elemento no topo): etiqueta vai para dentro da caixa.
        hoverLabel.style.top = rectIn(el, layer).top < 20 ? '0px' : '-20px'
      }
      box.style.display = 'block'
    },
    hideHover() {
      if (hover) hover.style.display = 'none'
    },
    isMarked(el) {
      return badges.some((b) => b.el === el)
    },
    mark(el) {
      if (badges.some((b) => b.el === el)) return null
      const n = next++
      const box = baseBox(doc, BADGE, 'rgba(217,119,87,.10)', !!layer)
      const num = doc.createElement('div')
      num.textContent = String(n)
      Object.assign(num.style, {
        position: 'absolute',
        top: '-10px',
        left: '-10px',
        width: '18px',
        height: '18px',
        borderRadius: '50%',
        background: BADGE,
        color: '#fff',
        font: 'bold 11px/18px system-ui, sans-serif',
        textAlign: 'center'
      })
      box.appendChild(num)
      place(box, el, layer)
      root().appendChild(box)
      badges.push({ el, box })
      return n
    },
    unmark(el) {
      badges = badges.filter((b) => {
        if (b.el !== el) return true
        b.box.remove()
        return false
      })
    },
    reposition() {
      for (const b of badges) {
        // Elemento saiu do DOM (SPA re-renderizou): esconde a marca.
        b.box.style.display = b.el.isConnected ? 'block' : 'none'
        if (b.el.isConnected) place(b.box, b.el, layer)
      }
    },
    clear() {
      for (const b of badges) b.box.remove()
      badges = []
      next = 1
    },
    retain(numberOf) {
      let max = 0
      badges = badges.filter((b) => {
        const n = numberOf(b.el)
        if (n === null) {
          b.box.remove()
          return false
        }
        const num = b.box.firstElementChild
        if (num) num.textContent = String(n)
        max = Math.max(max, n)
        return true
      })
      next = max + 1
    },
    destroy() {
      this.clear()
      hover?.remove()
      hover = null
      hoverLabel = null
    }
  }
}

/**
 * Número de cada marca no sync: o mesmo "[elemento N]" do campo de mensagem.
 *
 * O campo numera TODOS os elementos pela ordem do texto (de qualquer aba, do
 * Chrome também); a aba só recebe os dela. Por isso o host manda o número junto
 * de cada seletor — a posição na lista da aba não serve ("[elemento 3]" pode
 * ser o primeiro desta aba). Lista só de seletores (formato antigo) continua
 * valendo, numerada pela posição.
 */
export interface MarkRef {
  selector: string
  /** Número do "[elemento N]" no campo de mensagem. */
  n: number
}

/** Seletor → número da marca. Entrada inválida é ignorada; seletor repetido fica com o primeiro. */
export function markNumbers(value: unknown): Map<string, number> {
  const out = new Map<string, number>()
  if (!Array.isArray(value)) return out
  value.forEach((item: unknown, i) => {
    let selector: string | null = null
    let n = i + 1
    if (typeof item === 'string') selector = item
    else if (item && typeof item === 'object') {
      const ref = item as Partial<MarkRef>
      if (typeof ref.selector === 'string') selector = ref.selector
      if (typeof ref.n === 'number' && Number.isInteger(ref.n) && ref.n > 0) n = ref.n
    }
    if (selector !== null && !out.has(selector)) out.set(selector, n)
  })
  return out
}
