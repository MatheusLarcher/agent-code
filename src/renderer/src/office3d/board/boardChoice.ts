/**
 * Qual projeto o kanban mostra no escritório único (amb-quadro-projeto) — PURO:
 *
 * - com o filtro de projeto do HUD: o filtrado;
 * - sem filtro: o da conversa ativa; a troca manual pelas abas vale até a
 *   conversa ativa mudar; sem conversa ativa com quadro, o que já estava; senão
 *   o primeiro;
 * - durante a coreografia de um projeto que não está na parede (`visit`, a
 *   fila do boardStage.ts): ele — e, acabada a visita, volta à escolha acima.
 */
export class BoardChoice {
  /** Filtro de projeto do HUD (null = Todos). */
  filter: string | null = null
  /** Projeto visitado pela coreografia (null fora de visita). */
  visit: string | null = null
  private manual: string | null = null
  private activeId: string | null = null
  private activeProject: string | null = null
  private base: string | null = null

  /** A conversa ativa e o projeto dela (a cada feed): trocar de conversa desfaz a escolha manual. */
  setActive(activeId: string | null, project: string | null): void {
    if (activeId !== this.activeId) this.manual = null
    this.activeId = activeId
    this.activeProject = project
  }

  /** Clique numa aba. */
  choose(id: string): void {
    this.manual = id
  }

  /** O projeto da parede entre os que têm quadro (`ids`, na ordem do escritório). */
  pick(ids: readonly string[]): string | null {
    const has = (id: string | null): id is string => id !== null && ids.includes(id)
    if (this.filter !== null) this.base = has(this.filter) ? this.filter : null
    else if (has(this.manual)) this.base = this.manual
    else if (has(this.activeProject)) this.base = this.activeProject
    else if (!has(this.base)) this.base = ids[0] ?? null
    return has(this.visit) ? this.visit : this.base
  }

  /** A visita só vale para o projeto do filtro (com filtro, a parede não sai dele). */
  canVisit(id: string): boolean {
    return this.filter === null || this.filter === id
  }
}
