/**
 * O que o kanban põe na tela por cima do 3D (DOM): a dica do papel/pilha sob o
 * mouse (o nome da conversa, ou quantos cartões a pilha tem), a mensagem de
 * recusa do main perto do topo do quadro (BOARD_TOAST_MS) e a âncora dos selos
 * da coreografia (boardSeals.ts). `place` a cada quadro projeta tudo na tela.
 */
import { Vector3, type PerspectiveCamera } from 'three'
import type { OfficeScene } from '../scene'
import { CARD_KEY, parsePileKey } from './boardLayout'
import { columnIndex } from './boardModel'
import type { BoardSeals } from './boardSeals'

/** Quanto tempo a mensagem de recusa fica perto do quadro (ms). */
export const BOARD_TOAST_MS = 6_000

function layer(container: HTMLElement, className: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className
  el.hidden = true
  container.appendChild(el)
  return el
}

export class BoardTips {
  private readonly tipEl: HTMLDivElement
  private readonly toast: HTMLDivElement
  private readonly at = new Vector3()
  private tipKey: string | null = null
  private toastRoom: string | null = null
  private toastUntil = 0

  constructor(
    container: HTMLElement,
    private readonly scene: OfficeScene,
    private readonly camera: PerspectiveCamera,
    private readonly seals: BoardSeals,
    /** O projeto do cartão nos dados (o selo do que saiu da parede fica no topo do quadro dele). */
    private readonly roomOf: (cardId: string) => string | null
  ) {
    this.tipEl = layer(container, 'o3d-board-tip')
    this.toast = layer(container, 'o3d-board-toast')
    this.toast.setAttribute('role', 'alert')
  }

  /** A dica do papel/pilha `key` (null esconde). */
  tip(key: string | null, text: string): void {
    this.tipKey = key
    this.tipEl.textContent = text
    this.tipEl.hidden = key === null || !text
  }

  /** A mensagem (recusa do main) perto do quadro do projeto, por BOARD_TOAST_MS. */
  say(roomId: string, text: string, now: number): void {
    this.toast.textContent = text
    this.toastRoom = roomId
    this.toastUntil = now + BOARD_TOAST_MS
    this.toast.hidden = false
  }

  /** A mensagem vence; true se sumiu agora. */
  tick(now: number): boolean {
    if (!this.toastRoom || now < this.toastUntil) return false
    this.toastRoom = null
    this.toast.hidden = true
    return true
  }

  /** A mensagem em voo (testes e HUD). */
  get message(): string | null {
    return this.toastRoom ? this.toast.textContent : null
  }

  /** A cada quadro: a dica acima do papel em foco, a mensagem acima do quadro e os selos. */
  place(width: number, height: number): void {
    if (this.tipKey && !this.tipEl.hidden) this.put(this.tipEl, this.anchorOf(this.tipKey), width, height)
    if (this.toastRoom) {
      const view = this.scene.boards.view(this.toastRoom)
      if (view) view.topWorld(this.at)
      this.put(this.toast, !!view && this.scene.boards.visible(this.toastRoom), width, height)
    }
    if (this.seals.size > 0) this.seals.place((id, out) => this.sealAnchor(id, out), this.at, (p) => this.project(p, width, height))
  }

  /** O papel do selo; o que saiu do quadro fica no topo dele. */
  private sealAnchor(id: string, out: Vector3): boolean {
    const boards = this.scene.boards
    const room = boards.roomOfCard(id) ?? this.roomOf(id)
    const view = room ? boards.view(room) : undefined
    if (!room || !view || !boards.visible(room)) return false
    if (!view.paperWorld(id, out)) view.topWorld(out)
    return true
  }

  private project(p: Vector3, width: number, height: number): { x: number; y: number } | null {
    const v = p.project(this.camera)
    return v.z > -1 && v.z < 1 ? { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height } : null
  }

  private anchorOf(key: string): boolean {
    if (key.startsWith(CARD_KEY)) {
      const id = key.slice(CARD_KEY.length)
      const room = this.scene.boards.roomOfCard(id)
      return !!room && !!this.scene.boards.view(room)?.paperWorld(id, this.at)
    }
    const pile = parsePileKey(key)
    const view = pile ? this.scene.boards.view(pile.roomId) : undefined
    if (!pile || !view) return false
    view.pileWorld(columnIndex(pile.status), this.at)
    return true
  }

  /** Põe o elemento sobre o ponto `this.at` projetado (escondido se o ponto não está na frente da câmera). */
  private put(el: HTMLElement, ok: boolean, width: number, height: number): void {
    const v = ok ? this.at.project(this.camera) : null
    const on = !!v && v.z > -1 && v.z < 1
    el.style.visibility = on ? '' : 'hidden'
    if (!v || !on) return
    el.style.transform = `translate(${((v.x + 1) / 2) * width}px, ${((1 - v.y) / 2) * height}px) translate(-50%, -100%)`
  }

  dispose(): void {
    this.tipEl.remove()
    this.toast.remove()
  }
}
