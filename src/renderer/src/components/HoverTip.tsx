/**
 * O tooltip do app (PC e celular), no lugar do `title` nativo — que demora meio
 * segundo e não tem estilo. UMA camada montada na raiz ouve o documento:
 *
 * - mouse: parou num elemento com `data-tip` (ou `title`) → em SHOW_MS aparece um
 *   balão acima dele (abaixo, sem espaço), com seta e entrada curta. Indo de um
 *   para outro logo em seguida, o próximo vem na hora (WARM_MS);
 * - toque (celular): segurar PRESS_MS mostra o balão; o toque longo não vira
 *   clique nem menu, e o balão some sozinho em TOUCH_HIDE_MS;
 * - teclado: foco visível (Tab) também mostra.
 *
 * O `title` encontrado vira `data-tip` na hora (o nativo não chega a aparecer;
 * sem texto visível, ele vai para o `aria-label`). `data-no-tip` num ancestral
 * desliga. Rolar, clicar, Esc ou o elemento sumir escondem.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './hoverTip.css'

export const SHOW_MS = 90
const WARM_MS = 400
const PRESS_MS = 380
const TOUCH_HIDE_MS = 1600
const MOVE_SLOP = 10
const GAP = 8
const EDGE = 6

/** O elemento com tooltip sob `node` (o mais próximo), ou null. */
export function tipTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null
  const el = node.closest('[data-tip],[title]')
  if (!(el instanceof HTMLElement) || el.closest('[data-no-tip]')) return null
  return el
}

/** Move o `title` para `data-tip` (o nativo não aparece) e devolve o texto do tooltip. */
export function claimTip(el: HTMLElement): string {
  const title = el.getAttribute('title')
  if (title !== null) {
    el.removeAttribute('title')
    if (title.trim()) {
      el.setAttribute('data-tip', title)
      if (!el.hasAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', title)
    }
  }
  return (el.getAttribute('data-tip') ?? '').trim()
}

interface Shown {
  el: HTMLElement
  text: string
  touch: boolean
}

interface Place {
  left: number
  top: number
  below: boolean
  /** Onde a seta fica, em px a partir da esquerda do balão. */
  arrow: number
}

export function HoverTipLayer(): JSX.Element | null {
  const [shown, setShown] = useState<Shown | null>(null)
  const [place, setPlace] = useState<Place | null>(null)
  const bubble = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let hideTimer: ReturnType<typeof setTimeout> | null = null
    let current: HTMLElement | null = null
    let lastHide = 0
    let press: { el: HTMLElement; x: number; y: number } | null = null
    let eatClick = false
    let watch: MutationObserver | null = null

    const clear = (): void => {
      if (timer) clearTimeout(timer)
      if (hideTimer) clearTimeout(hideTimer)
      timer = hideTimer = null
    }
    const hide = (): void => {
      clear()
      watch?.disconnect()
      watch = null
      if (current) lastHide = Date.now()
      current = null
      setShown(null)
    }
    const show = (el: HTMLElement, touch: boolean): void => {
      const text = claimTip(el)
      if (!text || !el.isConnected) return
      current = el
      setShown({ el, text, touch })
      // O texto pode mudar com o balão aberto (contador subindo) ou o React devolver o title.
      watch?.disconnect()
      watch = new MutationObserver(() => {
        if (!el.isConnected) return hide()
        const next = claimTip(el)
        if (!next) return hide()
        setShown((s) => (s && s.el === el && s.text !== next ? { ...s, text: next } : s))
      })
      watch.observe(el, { attributes: true, attributeFilter: ['title', 'data-tip'] })
    }
    const schedule = (el: HTMLElement): void => {
      clear()
      current = el
      // O title some já: o nativo não pode aparecer antes do nosso.
      claimTip(el)
      const warm = Date.now() - lastHide < WARM_MS
      timer = setTimeout(() => show(el, false), warm ? 0 : SHOW_MS)
    }

    const onOver = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') return
      const el = tipTarget(e.target)
      if (el === current) return
      if (current) hide()
      if (el) schedule(el)
    }
    const onOut = (e: PointerEvent): void => {
      if (e.pointerType === 'touch' || !current) return
      const to = e.relatedTarget
      if (to instanceof Node && current.contains(to)) return
      hide()
    }
    const onDown = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch') return hide()
      hide()
      const el = tipTarget(e.target)
      if (!el) return
      claimTip(el)
      press = { el, x: e.clientX, y: e.clientY }
      timer = setTimeout(() => {
        if (!press) return
        eatClick = true
        show(press.el, true)
        hideTimer = setTimeout(hide, TOUCH_HIDE_MS)
      }, PRESS_MS)
    }
    const onMove = (e: PointerEvent): void => {
      if (!press || e.pointerType !== 'touch') return
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_SLOP) {
        press = null
        if (!current) clear()
      }
    }
    const onUp = (e: PointerEvent): void => {
      if (e.pointerType !== 'touch') return
      press = null
      if (!current) clear()
    }
    const onClick = (e: MouseEvent): void => {
      if (!eatClick) return
      eatClick = false
      e.preventDefault()
      e.stopPropagation()
    }
    const onMenu = (e: Event): void => {
      if (press || (current && eatClick)) e.preventDefault()
    }
    const onFocus = (e: FocusEvent): void => {
      const el = tipTarget(e.target)
      if (!el || el !== e.target) return
      let visible = false
      try {
        visible = el.matches(':focus-visible')
      } catch {
        visible = false
      }
      if (visible) schedule(el)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || current) hide()
    }
    const onAway = (): void => {
      if (current) hide()
    }

    const opts = { capture: true, passive: true } as const
    document.addEventListener('pointerover', onOver, opts)
    document.addEventListener('pointerout', onOut, opts)
    document.addEventListener('pointerdown', onDown, opts)
    document.addEventListener('pointermove', onMove, opts)
    document.addEventListener('pointerup', onUp, opts)
    document.addEventListener('pointercancel', onUp, opts)
    document.addEventListener('click', onClick, true)
    document.addEventListener('contextmenu', onMenu, true)
    document.addEventListener('focusin', onFocus, true)
    document.addEventListener('focusout', onAway, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('scroll', onAway, opts)
    document.addEventListener('wheel', onAway, opts)
    window.addEventListener('blur', onAway)
    window.addEventListener('resize', onAway)
    return () => {
      clear()
      watch?.disconnect()
      document.removeEventListener('pointerover', onOver, true)
      document.removeEventListener('pointerout', onOut, true)
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('pointermove', onMove, true)
      document.removeEventListener('pointerup', onUp, true)
      document.removeEventListener('pointercancel', onUp, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('contextmenu', onMenu, true)
      document.removeEventListener('focusin', onFocus, true)
      document.removeEventListener('focusout', onAway, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('scroll', onAway, true)
      document.removeEventListener('wheel', onAway, true)
      window.removeEventListener('blur', onAway)
      window.removeEventListener('resize', onAway)
    }
  }, [])

  // Mede o balão e o põe acima do elemento (abaixo sem espaço), dentro da janela.
  useLayoutEffect(() => {
    const b = bubble.current
    if (!shown || !b) return setPlace(null)
    const r = shown.el.getBoundingClientRect()
    const w = b.offsetWidth
    const h = b.offsetHeight
    const vw = document.documentElement.clientWidth || window.innerWidth
    const center = r.left + r.width / 2
    const left = Math.min(Math.max(EDGE, center - w / 2), Math.max(EDGE, vw - w - EDGE))
    const below = r.top - GAP - h < EDGE
    const top = below ? r.bottom + GAP : r.top - GAP - h
    setPlace({ left, top, below, arrow: Math.min(Math.max(10, center - left), w - 10) })
  }, [shown])

  if (!shown || typeof document === 'undefined') return null
  return createPortal(
    <div
      ref={bubble}
      className={`hover-tip${place ? ' on' : ''}${place?.below ? ' below' : ''}${shown.touch ? ' touch' : ''}`}
      role="tooltip"
      style={place ? { left: place.left, top: place.top, ['--tip-arrow' as string]: `${place.arrow}px` } : { left: -9999, top: -9999 }}
    >
      {shown.text}
    </div>,
    document.body
  )
}
