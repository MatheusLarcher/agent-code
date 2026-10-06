/**
 * Ponteiro do Escritório 3D: arrasto (esquerdo/direito giram, meio arrasta),
 * clique curto (seleciona), duplo clique (abre a conversa), roda (zoom) e o
 * hover (a prévia do agente). Só decide o gesto; o motor faz o que cada gancho
 * pede. Os ouvintes vão para o `listen` do motor (o dispose dele tira todos).
 *
 * Pegar um objeto (o papel do kanban): no pointerdown do botão esquerdo, o
 * `pick` decide — se `grab(key)` aceitar o que está sob o ponteiro, o arrasto é
 * DO OBJETO (`grabMove`/`grabDrop`, mão fechada) e não da câmera; fora dele a
 * câmera gira como sempre. Soltar sem passar do clique é clique (`grabCancel` +
 * `click`); `cancelGrab` (Esc) e `reset` desistem (`grabCancel`).
 *
 * Hover: só com o mouse sobre o canvas e nenhum botão apertado; o pick roda no
 * máximo a cada HOVER_PICK_MS (o último movimento que caiu no intervalo é
 * conferido no `flushHover`, que o motor chama no tique). O gancho só ouve
 * quando o que está sob o mouse MUDA; sair do canvas ou começar a arrastar dá null.
 */
import { dragModeFor, isClick, type DragMode, type MoveKeys } from './input'
import type { Listen } from './engineTypes'

export const HOVER_PICK_MS = 60

/**
 * Teclado e visibilidade do motor: Esc (`escape` diz se consumiu), WASD/Shift
 * (MoveKeys), blur da janela (nada fica preso) e documento oculto (`hidden`).
 * Com `paused()` (aba fechada) a tecla é de quem está na tela: nem preventDefault.
 */
export function bindKeys(
  listen: Listen,
  keys: MoveKeys,
  h: { paused(): boolean; escape(target: EventTarget | null): boolean; moved(): void; hidden(hidden: boolean): void }
): void {
  listen(window, 'keydown', (e) => {
    if (h.paused()) return
    if (e.key === 'Escape' && h.escape(e.target)) return e.preventDefault()
    if (keys.down(e)) {
      e.preventDefault()
      h.moved()
    }
  })
  listen(window, 'keyup', (e) => keys.up(e))
  listen(window, 'blur', () => keys.clear())
  listen(document, 'visibilitychange', () => h.hidden(document.hidden))
}

export interface PointerHooks {
  /** O que está sob o ponto do canvas em coordenadas normalizadas (-1..1): personagem, 'projector:<sala>', 'card:<id>'…; null no vazio. */
  pick(ndcX: number, ndcY: number): string | null
  /** Arrasto de câmera que passou do clique. */
  drag(mode: Exclude<DragMode, null>, dx: number, dy: number): void
  /** Clique curto do botão esquerdo, com o que estava sob ele (e o ponto, em coordenadas da janela). */
  click(key: string | null, at?: { x: number; y: number }): void
  /** Duplo clique. */
  open(key: string | null): void
  /** Roda: deltaY > 0 afasta. */
  zoom(deltaY: number): void
  /** O que está sob o mouse mudou. */
  hover(key: string | null): void
  /** Relógio (ms) do intervalo do hover. */
  now(): number
  /** Botão esquerdo desceu sobre `key`: true pega o objeto (o arrasto é dele, não da câmera). */
  grab?(key: string): boolean
  /** O objeto pego anda (passou do clique), em coordenadas normalizadas. */
  grabMove?(ndcX: number, ndcY: number): void
  /** Soltou o objeto pego depois de arrastar. */
  grabDrop?(ndcX: number, ndcY: number): void
  /** Desistiu do objeto pego (clique curto, Esc, aba fechada). */
  grabCancel?(): void
  /** Cursor sobre `key` (padrão: a mão de clicar). */
  cursor?(key: string): string
}

type Mode = Exclude<DragMode, null> | 'grab'

export class PointerInput {
  /** `key`: o que estava sob o botão esquerdo ao descer (o clique curto usa o mesmo, sem um segundo pick). */
  private drag: { mode: Mode; button: number; x0: number; y0: number; x: number; y: number; lifted: boolean; key: string | null; touch: boolean } | null = null
  private hovered: string | null = null
  private lastPick = -Infinity
  /** Movimento sobre o canvas ainda não conferido (caiu no intervalo do hover): reaproveitado, sem alocar. */
  private readonly pending = { x: 0, y: 0, on: false }
  /** Ponto normalizado reaproveitado. */
  private readonly ndc = { x: 0, y: 0 }
  /** Dedos na tela (toque): com dois, a pinça (zoom + giro) no lugar do arrasto. */
  private readonly touches = new Map<number, { x: number; y: number }>()
  private pinch: { dist: number; x: number; y: number } | null = null

  constructor(
    private readonly canvas: HTMLCanvasElement,
    listen: Listen,
    private readonly hooks: PointerHooks
  ) {
    const c = canvas
    listen(c, 'contextmenu', (e) => e.preventDefault())
    listen(c, 'pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
        // O 2º dedo: o arrasto (ou o objeto pego) do 1º desiste e vira pinça.
        if (this.touches.size >= 2) {
          if (this.drag?.mode === 'grab') this.cancelGrab()
          this.drag = null
          this.pinch = this.twoFinger()
          return
        }
      }
      const button = dragModeFor(e.button)
      if (!button) return
      if (e.button === 1) e.preventDefault()
      let mode: Mode = button
      const key = e.button === 0 ? this.pickAt(e.clientX, e.clientY) : null
      if (key && this.hooks.grab?.(key)) mode = 'grab'
      this.drag = { mode, button: e.button, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, lifted: false, key, touch: e.pointerType === 'touch' }
      this.setHover(null)
    })
    listen(window, 'pointermove', (e) => {
      if (this.touches.has(e.pointerId)) {
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (this.pinch) return this.pinchMove()
      }
      this.move(e)
    })
    const lift = (e: PointerEvent): void => {
      if (!this.touches.delete(e.pointerId)) return
      // Fim da pinça: o dedo que sobrou não vira arrasto nem clique.
      if (this.touches.size < 2) this.pinch = null
    }
    listen(window, 'pointercancel', (e) => {
      lift(e)
      this.drag = null
    })
    listen(window, 'pointerup', (e) => {
      const pinching = this.pinch !== null || this.touches.size >= 2
      lift(e)
      if (pinching) return
      const d = this.drag
      this.drag = null
      if (d?.mode === 'grab') {
        this.canvas.style.cursor = ''
        if (d.lifted) {
          const p = this.toNdc(e.clientX, e.clientY)
          return this.hooks.grabDrop?.(p.x, p.y)
        }
        this.hooks.grabCancel?.()
      }
      if (!d || d.button !== 0 || !isClick(e.clientX - d.x0, e.clientY - d.y0, d.touch)) return
      this.hooks.click(d.key, { x: e.clientX, y: e.clientY })
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

  /** Distância e ponto médio dos dois primeiros dedos. */
  private twoFinger(): { dist: number; x: number; y: number } {
    const [a, b] = [...this.touches.values()]
    return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }

  /** Dois dedos: afastar/aproximar é o zoom (na mesma escala da roda) e mover os dois juntos gira a câmera. */
  private pinchMove(): void {
    const prev = this.pinch
    if (!prev) return
    const next = this.twoFinger()
    this.pinch = next
    // rig.zoom multiplica a distância por exp(deltaY·0.001): a câmera acompanha a proporção da pinça.
    const deltaY = 1000 * Math.log(prev.dist / next.dist)
    if (Math.abs(deltaY) > 0.01) this.hooks.zoom(deltaY)
    const dx = next.x - prev.x
    const dy = next.y - prev.y
    if (dx || dy) this.hooks.drag('orbit', dx, dy)
  }

  /** Ponto da janela → coordenadas normalizadas do canvas (objeto reaproveitado). */
  private toNdc(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect()
    const w = rect.width || this.canvas.width || 1
    const h = rect.height || this.canvas.height || 1
    this.ndc.x = ((clientX - rect.left) / w) * 2 - 1
    this.ndc.y = -((clientY - rect.top) / h) * 2 + 1
    return this.ndc
  }

  /** Ponto da tela → o que está ali. */
  private pickAt(clientX: number, clientY: number): string | null {
    const p = this.toNdc(clientX, clientY)
    return this.hooks.pick(p.x, p.y)
  }

  /** O que está sob o mouse agora (null fora do canvas ou arrastando). */
  get hover(): string | null {
    return this.hovered
  }

  get dragging(): boolean {
    return this.drag !== null
  }

  /** Há um objeto pego (o papel do kanban)? */
  get grabbing(): boolean {
    return this.drag?.mode === 'grab'
  }

  private move(e: PointerEvent): void {
    const d = this.drag
    if (d) {
      const dx = e.clientX - d.x
      const dy = e.clientY - d.y
      d.x = e.clientX
      d.y = e.clientY
      if (isClick(e.clientX - d.x0, e.clientY - d.y0, d.touch)) return
      if (d.mode !== 'grab') return this.hooks.drag(d.mode, dx, dy)
      if (!d.lifted) {
        d.lifted = true
        this.canvas.style.cursor = 'grabbing'
      }
      const p = this.toNdc(e.clientX, e.clientY)
      this.hooks.grabMove?.(p.x, p.y)
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
    this.canvas.style.cursor = key ? (this.hooks.cursor?.(key) ?? 'pointer') : ''
    this.hooks.hover(key)
  }

  /** Desiste do objeto pego (Esc); true se havia um. */
  cancelGrab(): boolean {
    if (this.drag?.mode !== 'grab') return false
    this.drag = null
    this.canvas.style.cursor = ''
    this.hooks.grabCancel?.()
    return true
  }

  /** Aba fechada: solta o arrasto (e o objeto pego) e o hover. */
  reset(): void {
    this.cancelGrab()
    this.drag = null
    this.touches.clear()
    this.pinch = null
    this.pending.on = false
    this.setHover(null)
  }
}
