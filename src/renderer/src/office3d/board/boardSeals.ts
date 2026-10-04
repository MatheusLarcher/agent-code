/**
 * Os selos presos ao quadro (DOM): quando ninguém leva o papel, o selo ao lado
 * dele diz quem mudou e por quê (a frase da fala, em terceira pessoa); o do
 * usuário é o selinho "Você", curto. Clique no selo abre o cartão grande.
 *
 *   add(cardId, text, user, now)   põe (ou troca) o selo do cartão;
 *   tick(now)                      tira os vencidos; true se mudou;
 *   place(anchor, project)         a cada quadro: cada selo sobre o papel.
 */
import type { Vector3 } from 'three'

/** Selinho "Você" (ms) e selo com o motivo (ms). */
export const SEAL_USER_MS = 2_500
export const SEAL_MS = 6_000

interface Seal {
  el: HTMLButtonElement
  until: number
}

export class BoardSeals {
  private readonly seals = new Map<string, Seal>()
  private readonly layer: HTMLDivElement

  constructor(container: HTMLElement, private readonly onOpen: (cardId: string) => void) {
    this.layer = document.createElement('div')
    this.layer.className = 'o3d-board-seals'
    container.appendChild(this.layer)
  }

  add(cardId: string, text: string, user: boolean, now: number): void {
    let s = this.seals.get(cardId)
    if (!s) {
      const el = document.createElement('button')
      el.type = 'button'
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        this.onOpen(cardId)
      })
      this.layer.appendChild(el)
      s = { el, until: 0 }
      this.seals.set(cardId, s)
    }
    s.el.className = user ? 'o3d-board-seal o3d-board-seal--user' : 'o3d-board-seal'
    s.el.textContent = text
    s.el.title = user ? 'Você mudou este cartão' : `${text} — clique para ver o cartão`
    s.until = now + (user ? SEAL_USER_MS : SEAL_MS)
  }

  /** O texto do selo do cartão (testes). */
  text(cardId: string): string | null {
    return this.seals.get(cardId)?.el.textContent ?? null
  }

  get size(): number {
    return this.seals.size
  }

  tick(now: number): boolean {
    let changed = false
    for (const [id, s] of this.seals) {
      if (now < s.until) continue
      s.el.remove()
      this.seals.delete(id)
      changed = true
    }
    return changed
  }

  /** Cada selo sobre o papel: `anchor(id, out)` põe o ponto do papel no mundo; `project` devolve px ou null (fora da tela). */
  place(anchor: (cardId: string, out: Vector3) => boolean, at: Vector3, project: (p: Vector3) => { x: number; y: number } | null): void {
    for (const [id, s] of this.seals) {
      const p = anchor(id, at) ? project(at) : null
      s.el.style.visibility = p ? '' : 'hidden'
      if (p) s.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`
    }
  }

  clear(): void {
    for (const s of this.seals.values()) s.el.remove()
    this.seals.clear()
  }

  dispose(): void {
    this.clear()
    this.layer.remove()
  }
}
