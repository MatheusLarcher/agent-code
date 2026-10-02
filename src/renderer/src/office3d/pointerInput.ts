/**
 * Ponteiro do Escritório 3D: arrasto (esquerdo/direito giram, meio arrasta),
 * clique curto (seleciona), duplo clique (abre a conversa), roda (zoom) e o
 * hover (a prévia do agente). Só decide o gesto; o motor faz o que cada gancho
 * pede. Os ouvintes vão para o `listen` do motor (o dispose dele tira todos).
 *
 * Hover: só com o mouse sobre o canvas e nenhum botão apertado; o pick roda no
 * máximo a cada HOVER_PICK_MS (o último movimento que caiu no intervalo é
 * conferido no `flushHover`, que o motor chama no tique). O gancho só ouve
 * quando o que está sob o mouse MUDA; sair do canvas ou começar a arrastar dá null.
 */
import { dragModeFor, isClick, type DragMode } from './input'
import type { Listen } from './engineTypes'

export const HOVER_PICK_MS = 60

export interface PointerHooks {
  /** Personagem (ou 'projector:<sala>') sob o ponto do canvas em coordenadas normalizadas (-1..1); null no vazio. */
  pick(ndcX: number, ndcY: number): string | null
  /** Arrasto de câmera que passou do clique. */
  drag(mode: Exclude<DragMode, null>, dx: number, dy: number): void
  /** Clique curto do botão esquerdo, com o que estava sob ele. */
  click(key: string | null): void
  /** Duplo clique. */
  open(key: string | null): void
  /** Roda: deltaY > 0 afasta. */
  zoom(deltaY: number): void
  /** O que está sob o mouse mudou. */
  hover(key: string | null): void
  /** Relógio (ms) do intervalo do hover. */
  now(): number
}

export class PointerInput {
  private drag: { mode: Exclude<DragMode, null>; button: number; x0: number; y0: number; x: number; y: number } | null = null
  private hovered: string | null = null
  private lastPick = -Infinity
  /** Movimento sobre o canvas ainda não conferido (caiu no intervalo do hover): reaproveitado, sem alocar. */
  private readonly pending = { x: 0, y: 0, on: false }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    listen: Listen,
    private readonly hooks: PointerHooks
  ) {
    const c = canvas
    listen(c, 'contextmenu', (e) => e.preventDefault())
    listen(c, 'pointerdown', (e) => {
      const mode = dragModeFor(e.button)
      if (!mode) return
      if (e.button === 1) e.preventDefault()
      this.drag = { mode, button: e.button, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY }
      this.setHover(null)
    })
    listen(window, 'pointermove', (e) => this.move(e))
    listen(window, 'pointerup', (e) => {
      const d = this.drag
      this.drag = null
      if (!d || d.button !== 0 || !isClick(e.clientX - d.x0, e.clientY - d.y0)) return
      this.hooks.click(this.pickAt(e.clientX, e.clientY))
    })
    listen(c, 'dblclick', (e) => this.hooks.open(this.pickAt(e.clientX, e.clientY)))
    listen(
      c,
      'wheel',
      (e) => {
        e.preventDefault()
        this.hooks.zoom(e.deltaY)
      },
      { passive: false }
    )
    listen(c, 'pointerleave', () => {
      this.pending.on = false
      this.setHover(null)
    })
  }

  /** Ponto da tela → coordenadas normalizadas do canvas → o que está ali. */
  private pickAt(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect()
    const w = rect.width || this.canvas.width || 1
    const h = rect.height || this.canvas.height || 1
    return this.hooks.pick(((clientX - rect.left) / w) * 2 - 1, -((clientY - rect.top) / h) * 2 + 1)
  }

  /** O que está sob o mouse agora (null fora do canvas ou arrastando). */
  get hover(): string | null {
    return this.hovered
  }

  get dragging(): boolean {
    return this.drag !== null
  }

  private move(e: PointerEvent): void {
    const d = this.drag
    if (d) {
      const dx = e.clientX - d.x
      const dy = e.clientY - d.y
      d.x = e.clientX
      d.y = e.clientY
      if (!isClick(e.clientX - d.x0, e.clientY - d.y0)) this.hooks.drag(d.mode, dx, dy)
      return
    }
    if (e.target !== this.canvas) {
      this.pending.on = false
      this.setHover(null)
      return
    }
    const now = this.hooks.now()
    if (now - this.lastPick < HOVER_PICK_MS) {
      this.pending.x = e.clientX
      this.pending.y = e.clientY
      this.pending.on = true
      return
    }
    this.pickHover(e.clientX, e.clientY, now)
  }

  private pickHover(x: number, y: number, now: number): void {
    this.pending.on = false
    this.lastPick = now
    this.setHover(this.pickAt(x, y))
  }

  /** Confere o último movimento que ficou no intervalo (o motor chama no tique). */
  flushHover(): void {
    const p = this.pending
    if (p.on && !this.drag) this.pickHover(p.x, p.y, this.hooks.now())
  }

  private setHover(key: string | null): void {
    if (key === this.hovered) return
    this.hovered = key
    this.canvas.style.cursor = key ? 'pointer' : ''
    this.hooks.hover(key)
  }

  /** Aba fechada: solta o arrasto e o hover. */
  reset(): void {
    this.drag = null
    this.pending.on = false
    this.setHover(null)
  }
}
