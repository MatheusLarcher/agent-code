/**
 * Camada de balões do Escritório 3D — DOM puro, sem React por quadro.
 *
 * API pública:
 *   createBubbleLayer(container, { onClick(key) }): BubbleLayer
 *     Põe uma camada absoluta (.qb-layer, inset 0) dentro de `container`, que
 *     precisa ser posicionado (o .o3d-stage é). Estilos em quips.css.
 *   layer.set(key, quip | null): boolean  (true = o balão mudou)
 *     O mesmo Quip (identidade) não toca no DOM. Quip novo troca texto, ícone e
 *     kind e repete o "pop"; null anima a saída e devolve o elemento ao pool.
 *     Um set durante a saída reaproveita o mesmo elemento, sem piscar. Texto,
 *     ícone ou kind novos são MEDIDOS aqui (uma leitura de layout, num medidor
 *     fora das regras de compacto); sem layout (jsdom, palco escondido), estima.
 *   layer.size(key, out): boolean
 *     Balão inteiro (px, escala 1, com a ponta) medido no último set. Não lê layout.
 *   layer.place(key, x, y, scale, visible, stack?)
 *     (x, y) = onde a PONTA do balão encosta, em px do container; scale 1 =
 *     tamanho base, limitado a [SCALE_MIN, SCALE_MAX]. `stack` (opcional, vem do
 *     layout): compact = só o ícone; lift = andares que subiu para não cobrir
 *     outro (1+ fica atrás dos balões da cabeça e liga a ponta a (lx, ly) com uma
 *     linha-guia). Escreve transform e opacity (mais pointer-events, junto com a
 *     visibilidade: balão invisível não pega clique), classes só quando o
 *     compacto/andar muda e o transform da linha-guia só quando ela muda; nunca
 *     lê layout: dá para chamar a cada quadro para todos os personagens. Balão
 *     recém-criado fica invisível até o primeiro place visível.
 *   layer.compact(on)
 *     Zoom longe: todos os balões viram só o ícone, num distintivo redondo
 *     (classe qb-compact na camada; quem escolhe o que aparece é o motor).
 *   layer.dispose()
 *     Tira a camada, cancela os timers e remove os 3 listeners (delegados na
 *     camada: click, keydown, animationend). Depois disso tudo vira no-op.
 *
 * Um elemento por balão no ar; ao sair, ele volta ao pool e é reaproveitado.
 * Clique e Enter/Espaço no balão chamam onClick(key).
 */
import type { Quip } from './generator'
import './quips.css'

export interface BubbleLayerOptions {
  onClick(key: string): void
}

export interface BubbleSize {
  w: number
  h: number
}

/** Onde o layout pôs o balão (o chamador pode reaproveitar o mesmo objeto: a camada só copia). */
export interface BubbleStack {
  /** Só o ícone: o balão inteiro não coube. */
  compact: boolean
  /** Andares que subiu para não cobrir outro balão (0 = na cabeça). */
  lift: number
  /** Fim da linha-guia (px do container), logo acima da cabeça; vale com lift > 0. */
  lx: number
  ly: number
}

export interface BubbleLayer {
  set(key: string, quip: Quip | null): boolean
  size(key: string, out: BubbleSize): boolean
  place(key: string, x: number, y: number, scale: number, visible: boolean, stack?: BubbleStack): void
  compact(on: boolean): void
  dispose(): void
}

/** Duração da saída (qb-out) + folga: depois disso o elemento volta ao pool mesmo sem animationend. */
export const EXIT_MS = 240
export const SCALE_MIN = 0.6
export const SCALE_MAX = 1.4
/** Fonte do .qb-body em escala 1 (px) — a MESMA do quips.css (o motor garante a fonte mínima com ela). */
export const FONT_PX = 14
/** Ícone compacto em escala 1 (px, com a ponta): o lugar que o layout reserva para ele. */
export const COMPACT_W = 30
export const COMPACT_H = 28

/** Estimativa sem layout, nas medidas do quips.css (14 px, linha 1,35, max-width 220). */
const MAX_W = 220
const CHAR_W = 7.5
const LINE_H = 19
const ICON_W = 24

function estimate(q: Quip, out: BubbleSize): void {
  const cloud = q.kind === 'idle' || q.kind === 'thought'
  const padW = cloud ? 28 : 22
  const icon = q.icon ? ICON_W : 0
  const text = q.text.length * CHAR_W
  const lines = Math.max(1, Math.ceil(text / (MAX_W - padW - icon)))
  out.w = Math.min(MAX_W, padW + icon + text)
  out.h = lines * LINE_H + (cloud ? 17 + 19 : 15 + 8)
}

interface Shell {
  readonly el: HTMLDivElement
  readonly icon: HTMLSpanElement
  readonly text: HTMLSpanElement
}

interface Bubble extends Shell {
  readonly lead: HTMLSpanElement
  key: string
  quip: Quip | null
  leaving: boolean
  timer: ReturnType<typeof setTimeout> | null
  /** Balão inteiro (px, escala 1), medido quando a fala muda. */
  w: number
  h: number
  /** Último transform/visibilidade escritos (NaN/null = nada ainda). */
  x: number
  y: number
  s: number
  vis: boolean | null
  /** Último compacto/andar/linha-guia escritos. */
  compact: boolean
  lift: number
  leadLen: number
  leadAng: number
  /** Alterna o nome da animação de entrada para repetir o "pop" sem forçar reflow. */
  alt: boolean
}

export function createBubbleLayer(container: HTMLElement, opts: BubbleLayerOptions): BubbleLayer {
  const doc = container.ownerDocument
  const root = doc.createElement('div')
  root.className = 'qb-layer'
  container.appendChild(root)
  const live = new Map<string, Bubble>()
  const leaving = new Map<string, Bubble>()
  const free: Bubble[] = []
  const byEl = new WeakMap<Element, Bubble>()
  let disposed = false

  /** div.cls > .qb-body > .qb-icon + .qb-text, já na camada. */
  function shell(cls: string): Shell {
    const el = doc.createElement('div')
    el.className = cls
    const body = doc.createElement('div')
    body.className = 'qb-body'
    const icon = doc.createElement('span')
    icon.className = 'qb-icon'
    icon.setAttribute('aria-hidden', 'true')
    const text = doc.createElement('span')
    text.className = 'qb-text'
    body.append(icon, text)
    el.appendChild(body)
    root.appendChild(el)
    return { el, icon, text }
  }

  /** Medidor: a mesma caixa de um balão inteiro, invisível (nunca compacto, nunca na ordem dos cliques). */
  const meter = shell('qb-measure')
  meter.el.setAttribute('aria-hidden', 'true')

  const bubbleAt = (target: EventTarget | null): Bubble | undefined => {
    const el = (target as Element | null)?.closest?.('.qb')
    return el ? byEl.get(el) : undefined
  }
  const clickable = (target: EventTarget | null): Bubble | undefined => {
    const b = bubbleAt(target)
    return b && !b.leaving && b.quip ? b : undefined
  }

  const onClick = (e: MouseEvent): void => {
    const b = clickable(e.target)
    if (b) opts.onClick(b.key)
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const b = clickable(e.target)
    if (!b) return
    e.preventDefault()
    opts.onClick(b.key)
  }
  const onAnimationEnd = (e: AnimationEvent): void => {
    if (e.animationName !== 'qb-out') return
    const b = bubbleAt(e.target)
    if (b?.leaving) release(b)
  }
  root.addEventListener('click', onClick)
  root.addEventListener('keydown', onKey)
  root.addEventListener('animationend', onAnimationEnd)

  function create(): Bubble {
    const { el, icon, text } = shell('qb')
    el.setAttribute('role', 'button')
    el.tabIndex = 0
    const lead = doc.createElement('span')
    lead.className = 'qb-lead'
    el.appendChild(lead)
    const b: Bubble = {
      el, icon, text, lead, key: '', quip: null, leaving: false, timer: null, w: 0, h: 0,
      x: NaN, y: NaN, s: NaN, vis: null, compact: false, lift: 0, leadLen: NaN, leadAng: NaN, alt: false
    }
    byEl.set(el, b)
    return b
  }

  function acquire(key: string): Bubble {
    const b = free.pop() ?? create()
    b.key = key
    b.el.dataset.key = key
    b.x = b.y = b.s = NaN
    b.vis = false
    b.el.style.opacity = '0'
    b.el.style.pointerEvents = 'none'
    // Sair de display:none reinicia a animação de entrada.
    b.el.hidden = false
    return b
  }

  /** Tamanho do balão inteiro desta fala: uma leitura de layout, no medidor. */
  function measure(b: Bubble, quip: Quip): void {
    meter.el.dataset.kind = quip.kind
    meter.icon.textContent = quip.icon
    meter.text.textContent = quip.text
    const w = meter.el.offsetWidth
    const h = meter.el.offsetHeight
    if (w > 0 && h > 0) {
      b.w = w
      b.h = h
    } else {
      estimate(quip, b)
    }
  }

  function render(b: Bubble, quip: Quip, repop: boolean): void {
    const old = b.quip
    b.quip = quip
    b.el.dataset.kind = quip.kind
    if (b.icon.textContent !== quip.icon) b.icon.textContent = quip.icon
    b.text.textContent = quip.text
    if (!old || old.text !== quip.text || old.icon !== quip.icon || old.kind !== quip.kind) measure(b, quip)
    if (repop) {
      b.alt = !b.alt
      b.el.classList.toggle('qb-alt', b.alt)
    }
  }

  function stopLeaving(b: Bubble): void {
    if (b.timer !== null) clearTimeout(b.timer)
    b.timer = null
    b.leaving = false
    b.el.classList.remove('qb-out')
  }

  function release(b: Bubble): void {
    if (!b.leaving) return
    if (leaving.get(b.key) === b) leaving.delete(b.key)
    stopLeaving(b)
    b.el.hidden = true
    b.el.classList.remove('qb-alt', 'qb-compact', 'qb-up1', 'qb-up2')
    b.alt = false
    b.compact = false
    b.lift = 0
    b.leadLen = b.leadAng = NaN
    b.quip = null
    free.push(b)
  }

  function leave(b: Bubble): void {
    const old = leaving.get(b.key)
    if (old && old !== b) release(old)
    b.leaving = true
    b.el.classList.add('qb-out')
    leaving.set(b.key, b)
    b.timer = setTimeout(() => release(b), EXIT_MS)
  }

  /** Linha-guia da ponta até (lx, ly), no espaço do balão (dividido pela escala dele). */
  function guide(b: Bubble, lx: number, ly: number): void {
    const dx = (lx - b.x) / b.s
    const dy = (ly - b.y) / b.s
    const len = Math.round(Math.sqrt(dx * dx + dy * dy))
    const ang = Math.round(Math.atan2(-dx, dy) * 100) / 100
    if (!Number.isFinite(len) || (len === b.leadLen && ang === b.leadAng)) return
    b.leadLen = len
    b.leadAng = ang
    b.lead.style.transform = `rotate(${ang}rad) scaleY(${len})`
  }

  function put(b: Bubble, x: number, y: number, scale: number, visible: boolean, stack: BubbleStack | undefined): void {
    const vis = visible && Number.isFinite(x) && Number.isFinite(y)
    if (vis) {
      const rx = Math.round(x)
      const ry = Math.round(y)
      const s = Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number.isFinite(scale) ? scale : 1)) * 100) / 100
      if (rx !== b.x || ry !== b.y || s !== b.s) {
        b.x = rx
        b.y = ry
        b.s = s
        b.el.style.transform = `translate3d(${rx}px, ${ry}px, 0) scale(${s}) translate(-50%, -100%)`
      }
      const compact = stack !== undefined && stack.compact
      const lift = stack ? stack.lift : 0
      if (compact !== b.compact) {
        b.compact = compact
        b.el.classList.toggle('qb-compact', compact)
      }
      if (lift !== b.lift) {
        b.lift = lift
        b.el.classList.toggle('qb-up1', lift === 1)
        b.el.classList.toggle('qb-up2', lift >= 2)
      }
      if (lift > 0 && stack) guide(b, stack.lx, stack.ly)
    }
    if (vis !== b.vis) {
      b.vis = vis
      b.el.style.opacity = vis ? '' : '0'
      b.el.style.pointerEvents = vis ? '' : 'none'
    }
  }

  return {
    set(key, quip) {
      if (disposed) return false
      const cur = live.get(key)
      if (!quip) {
        if (!cur) return false
        live.delete(key)
        leave(cur)
        return true
      }
      if (cur) {
        if (cur.quip === quip) return false
        render(cur, quip, true)
        return true
      }
      const back = leaving.get(key)
      if (back) {
        leaving.delete(key)
        stopLeaving(back)
        render(back, quip, true)
        live.set(key, back)
      } else {
        const b = acquire(key)
        render(b, quip, false)
        live.set(key, b)
      }
      return true
    },

    size(key, out) {
      const b = live.get(key)
      if (!b) return false
      out.w = b.w
      out.h = b.h
      return true
    },

    place(key, x, y, scale, visible, stack) {
      const b = live.get(key)
      if (b) put(b, x, y, scale, visible, stack)
      const out = leaving.get(key)
      if (out) put(out, x, y, scale, visible, stack)
    },

    compact(on) {
      if (!disposed) root.classList.toggle('qb-compact', on)
    },

    dispose() {
      if (disposed) return
      disposed = true
      root.removeEventListener('click', onClick)
      root.removeEventListener('keydown', onKey)
      root.removeEventListener('animationend', onAnimationEnd)
      for (const b of leaving.values()) if (b.timer !== null) clearTimeout(b.timer)
      live.clear()
      leaving.clear()
      free.length = 0
      root.remove()
    }
  }
}
