/**
 * Seletor de elementos restrito a um elemento raiz: o mesmo modo Selecionar do
 * <webview> (src/preload/previewInspector), só que para os visualizadores de
 * arquivo que rodam dentro do próprio app (markdown, planilha, slides, código,
 * json). Reaproveita a camada visual (overlay.ts) e o seletor (selector.ts).
 *
 * - Eventos só dentro de `root`, em captura: com o modo ligado, clique vira
 *   seleção e nenhum clique/tecla chega ao visualizador; desligado, nada muda.
 * - Mira (crosshair) só na raiz.
 * - Marcas desenhadas em `layer` (sobre a raiz, recortada pela área dela) e
 *   reposicionadas em qualquer rolagem dentro da raiz ou resize.
 * - Esc só desliga o modo: as marcas ficam até o elemento sair do campo de
 *   mensagem (`sync`, mesma regra do handler de sync do preload).
 */
import { createOverlay, markNumbers, type MarkRef } from '../../../../preload/previewInspector/overlay'
import { buildSelector, captureElement, type ElementCapture } from '../../../../preload/previewInspector/selector'

export interface RootPick extends ElementCapture {
  index: number
}

export interface RootInspectorOptions {
  /** Só eventos dentro dela contam; é onde fica a mira. */
  root: HTMLElement
  /** Camada (pointer-events:none) onde hover e marcas são desenhados. */
  layer: HTMLElement
  onPick: (pick: RootPick) => void
  /** Esc com o modo ligado (o modo já foi desligado aqui). */
  onEsc: () => void
}

export interface RootInspector {
  setOn(on: boolean): void
  isOn(): boolean
  /**
   * Fica marcado só o que está em `marks` (o campo de mensagem), com o número
   * de lá: o "[elemento N]" global. Lista só de seletores = numerada pela posição.
   */
  sync(marks: readonly (MarkRef | string)[]): void
  clear(): void
  reposition(): void
  destroy(): void
}

const PICKING_ATTR = 'data-pv-picking'
const CURSOR_STYLE_ID = 'pv-file-picker-cursor'

/** Mira só dentro da raiz em modo seleção (um <style> por documento). */
function ensureCursorStyle(doc: Document): void {
  if (doc.getElementById(CURSOR_STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = CURSOR_STYLE_ID
  style.textContent = `[${PICKING_ATTR}], [${PICKING_ATTR}] * { cursor: crosshair !important; }`
  ;(doc.head ?? doc.documentElement).appendChild(style)
}

// Clique vira seleção: os eventos que disparariam ação no visualizador são barrados.
const BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'contextmenu', 'auxclick', 'dblclick'] as const

export function createRootInspector({ root, layer, onPick, onEsc }: RootInspectorOptions): RootInspector {
  const doc = root.ownerDocument
  const win = doc.defaultView
  const overlay = createOverlay(doc, { layer })
  let on = false
  /** Seletor de cada elemento marcado (o mesmo que foi ao campo de mensagem). */
  const markedSelector = new Map<Element, string>()

  const inside = (el: Element | null): el is Element => !!el && el !== root && root.contains(el)

  const targetAt = (e: MouseEvent): Element | null => {
    const fromPoint = doc.elementFromPoint?.(e.clientX, e.clientY) ?? null
    const el = fromPoint ?? (e.target instanceof Element ? e.target : null)
    return inside(el) ? el : null
  }

  const block = (e: Event): void => {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
  }

  const onMove = (e: MouseEvent): void => {
    const el = targetAt(e)
    if (el) overlay.showHover(el, buildSelector(el))
    else overlay.hideHover()
  }

  const onLeave = (): void => overlay.hideHover()

  const onClick = (e: MouseEvent): void => {
    block(e)
    const el = targetAt(e)
    if (!el) return
    const index = overlay.mark(el)
    if (index === null) return
    const capture = captureElement(el)
    markedSelector.set(el, capture.selector)
    onPick({ ...capture, index })
  }

  const onKey = (e: KeyboardEvent): void => {
    // Tab segue movendo o foco (não age no visualizador e não prende o teclado).
    if (e.key === 'Tab') return
    // Nenhuma outra tecla chega ao visualizador (setas do SlidesView etc.).
    block(e)
    if (e.key !== 'Escape') return
    setOn(false)
    onEsc()
  }

  const onReposition = (): void => overlay.reposition()

  // Rolagem (da raiz ou de algo dentro dela) e resize valem com o modo ligado ou
  // não: as marcas ficam depois do Esc e precisam seguir o elemento.
  root.addEventListener('scroll', onReposition, true)
  win?.addEventListener('resize', onReposition)
  const RO = (win as (Window & { ResizeObserver?: typeof ResizeObserver }) | null)?.ResizeObserver
  const resizeObs = RO ? new RO(onReposition) : null
  resizeObs?.observe(root)
  // O visualizador trocou o conteúdo (outro slide, outra aba da planilha): a
  // marca de um elemento que saiu do DOM some na hora, sem esperar rolagem.
  const MO = (win as (Window & { MutationObserver?: typeof MutationObserver }) | null)?.MutationObserver
  const mutationObs = MO ? new MO(onReposition) : null
  mutationObs?.observe(root, { childList: true, subtree: true })

  function setOn(next: boolean): void {
    if (next === on) return
    on = next
    const listen: (type: string, l: EventListener) => void = next
      ? (t, l) => root.addEventListener(t, l, true)
      : (t, l) => root.removeEventListener(t, l, true)
    listen('mousemove', onMove as EventListener)
    listen('mouseleave', onLeave)
    listen('click', onClick as EventListener)
    listen('keydown', onKey as EventListener)
    for (const type of BLOCKED) listen(type, block)
    if (next) {
      ensureCursorStyle(doc)
      root.setAttribute(PICKING_ATTR, '')
      // Foco na raiz: o Esc funciona logo depois de ligar o modo.
      root.focus?.({ preventScroll: true })
    } else {
      root.removeAttribute(PICKING_ATTR)
      overlay.hideHover()
    }
  }

  return {
    setOn,
    isOn: () => on,
    sync(marks) {
      const keep = markNumbers(marks)
      overlay.retain((el) => {
        const sel = markedSelector.get(el)
        const n = sel === undefined ? undefined : keep.get(sel)
        if (n === undefined) markedSelector.delete(el)
        return n ?? null
      })
    },
    clear() {
      overlay.clear()
      markedSelector.clear()
    },
    reposition: onReposition,
    destroy() {
      setOn(false)
      root.removeEventListener('scroll', onReposition, true)
      win?.removeEventListener('resize', onReposition)
      resizeObs?.disconnect()
      mutationObs?.disconnect()
      overlay.destroy()
      markedSelector.clear()
    }
  }
}
