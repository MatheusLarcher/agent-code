/**
 * Preload do <webview> da aba Preview: o modo seleção de elementos (porte do
 * browser-inspector-preload do Nexos, só a parte do inspetor).
 *
 * O main impõe este arquivo em todo <webview> (previewProtocol.ts →
 * hardenPreviewWebviews), já compilado como out/preload/previewInspector.cjs.
 * Conversa com a página host por sendToHost / ipc-message (canais em
 * PREVIEW_INSPECTOR, src/shared/preview.ts):
 *
 *   ready   guest→host  ao carregar (o host reenvia o toggle depois de navegar)
 *   toggle  host→guest  liga/desliga o modo (boolean)
 *   clear   host→guest  apaga as marcas numeradas
 *   picked  guest→host  elemento clicado (InspectorPick)
 *   esc     guest→host  Esc com o modo ligado (o host desliga o botão)
 *   dragfile guest→host arquivo arrastado sobre a página (o host mostra a camada de soltar)
 *
 * Nada é exposto à página (sem contextBridge): ela não enxerga o preload.
 */
import { ipcRenderer } from 'electron'
import { PREVIEW_INSPECTOR, type InspectorPick } from '../../shared/preview'
import { createOverlay, markNumbers } from './overlay'
import { buildSelector, captureElement } from './selector'

export interface InspectorIpc {
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  sendToHost(channel: string, ...args: unknown[]): void
}

/** Intervalo mínimo entre dois avisos de dragover (o evento dispara sem parar). */
const DRAG_NOTICE_MS = 250

/**
 * Arquivo do Explorer arrastado por cima da página: avisa o host (que mostra a
 * camada de soltar do painel) e barra o padrão, para a página não abrir o
 * arquivo no lugar dela. Arraste interno da página (texto, link) segue normal.
 */
function watchFileDrag(ipc: InspectorIpc, win: Window): void {
  let last = 0
  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  const onDrag = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    const now = Date.now()
    if (e.type === 'dragover' && now - last < DRAG_NOTICE_MS) return
    last = now
    ipc.sendToHost(PREVIEW_INSPECTOR.dragfile)
  }
  const onDrop = (e: DragEvent): void => {
    if (hasFiles(e)) e.preventDefault()
  }
  win.addEventListener('dragenter', onDrag as EventListener, true)
  win.addEventListener('dragover', onDrag as EventListener, true)
  win.addEventListener('drop', onDrop as EventListener, true)
}

/** Liga o inspetor numa janela; devolve o estado para teste. */
export function installInspector(ipc: InspectorIpc, win: Window = window): { isOn: () => boolean } {
  const doc = win.document
  const overlay = createOverlay(doc)
  let on = false
  let cursorStyle: HTMLStyleElement | null = null
  /** Seletor de cada elemento marcado (o mesmo que foi ao campo de mensagem). */
  const markedSelector = new Map<Element, string>()

  // O construtor Element da própria janela (o tipo Window do lib.dom não o declara).
  const ElementCtor = (win as unknown as { Element: typeof Element }).Element
  const targetAt = (e: MouseEvent): Element | null => {
    const el = doc.elementFromPoint?.(e.clientX, e.clientY) ?? (e.target instanceof ElementCtor ? e.target : null)
    return el && el !== doc.documentElement ? el : null
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

  const onOut = (e: MouseEvent): void => {
    // Mouse saiu da página.
    if (!e.relatedTarget) overlay.hideHover()
  }

  const onClick = (e: MouseEvent): void => {
    block(e)
    const el = targetAt(e)
    if (!el) return
    const index = overlay.mark(el)
    if (index === null) return
    const pick: InspectorPick = { ...captureElement(el), url: win.location.href, index }
    markedSelector.set(el, pick.selector)
    ipc.sendToHost(PREVIEW_INSPECTOR.picked, pick)
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    block(e)
    setOn(false)
    ipc.sendToHost(PREVIEW_INSPECTOR.esc)
  }

  const onReposition = (): void => overlay.reposition()

  // Clique vira seleção: os eventos que disparariam ação na página são barrados.
  const blocked = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'contextmenu', 'auxclick', 'dblclick'] as const

  function setOn(next: boolean): void {
    if (next === on) return
    on = next
    const listen: (type: string, l: EventListener, capture?: boolean) => void = next
      ? (t, l, c) => win.addEventListener(t, l, c)
      : (t, l, c) => win.removeEventListener(t, l, c)
    listen('mousemove', onMove as EventListener, true)
    listen('mouseout', onOut as EventListener, true)
    listen('click', onClick as EventListener, true)
    listen('keydown', onKey as EventListener, true)
    listen('scroll', onReposition, true)
    listen('resize', onReposition)
    for (const type of blocked) listen(type, block, true)
    if (next) {
      cursorStyle = doc.createElement('style')
      cursorStyle.textContent = '*{cursor:crosshair !important}'
      ;(doc.head ?? doc.documentElement).appendChild(cursorStyle)
    } else {
      cursorStyle?.remove()
      cursorStyle = null
      // As marcas ficam: saem só quando o elemento sai do campo de mensagem (sync).
      overlay.hideHover()
    }
  }

  ipc.on(PREVIEW_INSPECTOR.toggle, (_e, value) => setOn(Boolean(value)))
  ipc.on(PREVIEW_INSPECTOR.clear, () => {
    overlay.clear()
    markedSelector.clear()
  })
  // Só fica marcado o que ainda está no campo de mensagem, com o número de lá
  // (o "[elemento N]" global, não a posição na lista desta aba).
  ipc.on(PREVIEW_INSPECTOR.sync, (_e, value) => {
    const keep = markNumbers(value)
    overlay.retain((el) => {
      const sel = markedSelector.get(el)
      const n = sel === undefined ? undefined : keep.get(sel)
      if (n === undefined) markedSelector.delete(el)
      return n ?? null
    })
  })
  watchFileDrag(ipc, win)
  ipc.sendToHost(PREVIEW_INSPECTOR.ready)

  return { isOn: () => on }
}

// Só no <webview> de verdade (o teste importa installInspector sem efeito colateral).
if (typeof window !== 'undefined' && typeof ipcRenderer?.sendToHost === 'function') {
  installInspector(ipcRenderer as unknown as InspectorIpc)
}
