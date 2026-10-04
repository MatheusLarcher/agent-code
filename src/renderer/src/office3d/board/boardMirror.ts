/**
 * O quadro de UMA sala em duas camadas — PURO:
 *
 *   real   o último retrato do Quadro (o alvo);
 *   shown  o que a parede mostra agora.
 *
 * A parede só anda quando um passo da fila é aplicado (`applyCard`), e a ordem
 * dentro de cada coluna é sempre a do retrato real. Primeira leitura, volta da
 * aba ou quadro indisponível vão direto (`setTarget(…, direct)`: sem replay).
 *
 * Invariante: nenhum cartão fica mais que MAX_LAG_MS diferente do real —
 * `overdue` devolve os atrasados e quem chama aplica direto.
 *
 * Arrasto do usuário (`userMove`): otimista — o papel já fica na coluna nova
 * (no topo, onde o main vai pô-lo: é o mais recente). Enquanto o `boardMove`
 * não volta, o cartão não é tocado por retrato nenhum; recusado, volta ao real
 * (`endUserMove(id, false)`). Quando o retrato confirma, ele já está no lugar e
 * aplicar o passo não o move: o movimento do usuário não reanima.
 */
import type { BoardItemStatus } from '@shared/ipc'
import type { BoardCard, BoardSnap } from './boardModel'

/** O quadro 3D nunca fica mais que isto diferente do real (ms). */
export const MAX_LAG_MS = 15_000

const sameCard = (a: BoardCard, b: BoardCard): boolean => a.revision === b.revision && a.status === b.status && a.title === b.title

export class BoardMirror {
  private target: BoardSnap | null = null
  private cards: BoardCard[] = []
  /** Cartão → desde quando (ms) a parede difere do real. */
  private readonly diverged = new Map<string, number>()
  /** Arrastos do usuário esperando o `boardMove`. */
  private readonly moves = new Map<string, BoardItemStatus>()
  /** Sobe a cada mudança no que a parede mostra. */
  version = 0

  /** Já houve a 1ª leitura. */
  get loaded(): boolean {
    return this.target !== null
  }

  /** null antes da 1ª leitura; false = quadro indisponível (não é vazio). */
  get available(): boolean | null {
    return this.target ? this.target.available : null
  }

  get real(): BoardSnap | null {
    return this.target
  }

  get shown(): readonly BoardCard[] {
    return this.cards
  }

  card(id: string): BoardCard | undefined {
    return this.cards.find((c) => c.id === id)
  }

  /** Há arrasto do usuário esperando a resposta. */
  moving(id: string): boolean {
    return this.moves.has(id)
  }

  /** Retrato novo. `direct`: a parede vai já para ele (1ª leitura, volta, indisponível). */
  setTarget(next: BoardSnap, now: number, direct = false): void {
    const wasAvailable = this.target?.available ?? false
    this.target = next
    if (direct || !next.available || !wasAvailable) {
      this.applyAll()
      return
    }
    const shown = new Map(this.cards.map((c) => [c.id, c]))
    const seen = new Set<string>()
    for (const c of next.cards) {
      seen.add(c.id)
      const s = shown.get(c.id)
      if (this.moves.has(c.id) || (s && sameCard(s, c))) this.diverged.delete(c.id)
      else if (!this.diverged.has(c.id)) this.diverged.set(c.id, now)
    }
    for (const c of this.cards) {
      if (seen.has(c.id) || this.moves.has(c.id)) continue
      if (!this.diverged.has(c.id)) this.diverged.set(c.id, now)
    }
    for (const id of [...this.diverged.keys()]) if (!seen.has(id) && !shown.has(id)) this.diverged.delete(id)
  }

  /** O passo de um cartão chegou: a parede passa a mostrar o real dele. */
  applyCard(id: string): void {
    if (!this.target || this.moves.has(id)) return
    const real = this.target.cards.find((c) => c.id === id)
    const i = this.cards.findIndex((c) => c.id === id)
    if (real) {
      if (i >= 0) this.cards[i] = real
      else this.cards.push(real)
    } else if (i >= 0) {
      this.cards.splice(i, 1)
    }
    this.diverged.delete(id)
    this.reorder()
    this.version++
  }

  /** A parede inteira vai para o real (sem animar o caminho). */
  applyAll(): void {
    this.cards = this.target?.available ? this.target.cards.slice() : []
    this.diverged.clear()
    // Arrasto em voo continua otimista: o papel fica onde o usuário soltou.
    for (const [id, status] of this.moves) {
      const i = this.cards.findIndex((c) => c.id === id)
      if (i >= 0) this.cards[i] = { ...this.cards[i], status }
    }
    if (this.moves.size > 0) this.reorder()
    this.version++
  }

  /** Cartões diferentes do real há MAX_LAG_MS ou mais (quem chama aplica direto). */
  overdue(now: number): string[] {
    const out: string[] = []
    for (const [id, since] of this.diverged) if (now - since >= MAX_LAG_MS) out.push(id)
    return out
  }

  /** A parede ainda deve o real deste cartão (false: já está no lugar — arrasto no 3D, atraso aplicado). */
  differs(id: string): boolean {
    return this.diverged.has(id)
  }

  /** Quantos cartões a parede ainda deve ao real. */
  get pending(): number {
    return this.diverged.size
  }

  /** Arrasto do usuário (otimista). false se o cartão não está na parede ou já está nessa coluna. */
  userMove(id: string, status: BoardItemStatus): boolean {
    const i = this.cards.findIndex((c) => c.id === id)
    if (i < 0 || this.cards[i].status === status || this.moves.has(id)) return false
    this.cards[i] = { ...this.cards[i], status }
    this.moves.set(id, status)
    this.diverged.delete(id)
    this.reorder()
    this.version++
    return true
  }

  /** O `boardMove` respondeu. Recusado: o papel volta ao real. Aceito: espera o retrato confirmar (MAX_LAG_MS). */
  endUserMove(id: string, ok: boolean, now: number): void {
    if (!this.moves.delete(id)) return
    if (!ok) return this.applyCard(id)
    const real = this.target?.cards.find((c) => c.id === id)
    const shown = this.card(id)
    if (real && shown && real.status === shown.status) this.applyCard(id)
    else this.diverged.set(id, now)
  }

  /**
   * Ordem do real; o arrastado em voo vai para o topo (é onde o main o põe) e
   * quem saiu do real (esperando o passo) fica logo depois de quem estava antes dele.
   */
  private reorder(): void {
    const index = new Map((this.target?.cards ?? []).map((c, i) => [c.id, i]))
    let last = -1
    const ranked = this.cards.map((c, k) => {
      let rank: number
      if (this.moves.has(c.id)) rank = -1
      else if (index.has(c.id)) rank = last = index.get(c.id) as number
      else rank = last + 0.5
      return { c, rank, k }
    })
    ranked.sort((a, b) => a.rank - b.rank || a.k - b.k)
    this.cards = ranked.map((r) => r.c)
  }
}
