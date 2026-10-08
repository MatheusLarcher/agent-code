import { currentEnvio, parseMs, type HandoffEnvio } from '../../shared/handoffTracking'
import type { BoardItem } from '../../shared/ipc'
import type { HandoffRepository } from '../persistence/types'
import type { HandoffBoard } from './handoffJobs'
import * as rules from './handoffRules'
import type { ConvState } from './handoffState'

/**
 * O RECONCILIADOR central: os envios que JÁ saíram e não concluíram acompanham
 * o Quadro do PROJETO — o trabalho feito noutra conversa do mesmo projeto conta,
 * o cartão concluído que expirou continua valendo, e nada depende do estado em
 * memória (roda igual depois de reiniciar). As decisões são de handoffRules.ts
 * (syncEntregas, reconcileEnvioPatch); aqui só a ordem de leitura e escrita.
 *
 * Quem chama: toda mudança no Quadro (HandoffTracker.boardChanged), a varredura
 * que marca envio como parado (HandoffTracker.sweep) e uma passada por projeto
 * no boot (HandoffTracker.loadKnown). Rajadas coalescem por projeto; a escrita
 * de cada conversa roda NA FILA dela no tracker — nunca em corrida com o fim de
 * turno.
 */

export interface ReconcilerDeps {
  repo(): HandoffRepository | null
  board: HandoffBoard
  now(): number
  poEnabled(): boolean
  /** Avisa a tela (handoff:changed) — só a conversa que mudou. */
  changed(convId: string): void
  /** As conversas em memória: turno rodando, pasta da sessão e o destino do retrabalho. */
  states(): ReadonlyMap<string, ConvState>
  /** A fila de escrita da conversa (HandoffTracker.exclusive). */
  exclusive<T>(convId: string, job: () => Promise<T>): Promise<T>
  warn(where: string, err: unknown): void
}

export interface EntregaSync {
  now: string
  poEnabled: boolean
}

/** A passada da mudança no Quadro (e da varredura) só relê o envio com atividade
 *  (`updatedAt`) nesta janela; a do boot relê todos. */
export const RECONCILE_RECENT_MS = 30 * 24 * 60 * 60_000

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * Os cartões do PROJETO inteiro, dispensados inclusive (cardForEtapa decide o
 * que deles vale). Tenta as pastas na ordem — a da sessão primeiro; a gravada no
 * envio pode ser de outro PC. Pasta que hoje é de outro projeto é pulada.
 * `null` = Quadro indisponível.
 */
export async function projectCards(board: HandoffBoard, projectId: string, cwds: readonly string[]): Promise<BoardItem[] | null> {
  for (const cwd of new Set(cwds.filter(Boolean))) {
    const items = await board.list(cwd, { includeDismissed: true })
    if (!items) continue
    const mine = items.filter((card) => card.projectId === projectId)
    if (mine.length > 0 || items.length === 0) return mine
  }
  return null
}

/** As entregas do envio acompanhando os cartões (a corrigida pelo usuário fica). */
export async function syncEnvio(
  repo: HandoffRepository,
  envio: HandoffEnvio,
  cards: readonly BoardItem[],
  sync: EntregaSync
): Promise<{ envio: HandoffEnvio; wrote: boolean }> {
  let out = envio
  const patches = rules.syncEntregas(envio, cards, sync)
  for (const { id, patch } of patches) out = await repo.updateHandoffEntrega(id, patch)
  return { envio: out, wrote: patches.length > 0 }
}

export class HandoffReconciler {
  /** Projetos com passada agendada que ainda não começou a ler → se ela relê todos os envios (o boot). */
  private readonly dirty = new Map<string, boolean>()
  private readonly runs = new Map<string, Promise<void>>()

  constructor(private readonly deps: ReconcilerDeps) {}

  /**
   * Agenda uma passada no projeto: só os envios com atividade nos últimos
   * RECONCILE_RECENT_MS, ou todos com `all` (o boot). A mudança que chega antes
   * de a passada agendada começar a ler já é vista por ela (coalesce — e o
   * `all` de qualquer pedido vale); a que chega depois agenda a seguinte. Nunca lança.
   */
  schedule(projectId: string, all = false): void {
    if (!projectId) return
    if (this.dirty.has(projectId)) {
      if (all) this.dirty.set(projectId, true)
      return
    }
    this.dirty.set(projectId, all)
    const run = (this.runs.get(projectId) ?? Promise.resolve())
      .then(() => {
        const everything = this.dirty.get(projectId) === true
        this.dirty.delete(projectId)
        return this.reconcileProject(projectId, everything)
      })
      .catch((err: unknown) => this.deps.warn('reconcile', err))
    this.runs.set(projectId, run)
    void run.then(() => {
      if (this.runs.get(projectId) === run) this.runs.delete(projectId)
    })
  }

  /** Boot: uma passada por projeto com envio saído e não concluído — todos, sem
   *  janela (o Quadro pode ter andado com o app fechado). Lança se o banco falhar. */
  async scheduleUnsettled(repo: HandoffRepository): Promise<void> {
    const envios = await repo.listHandoffEnvios({ statuses: [...rules.RECONCILE_STATUSES], limit: 1000 })
    for (const projectId of new Set(envios.filter(rules.isReconcilable).map((e) => e.projectId))) this.schedule(projectId, true)
  }

  /** As passadas em curso (HandoffTracker.settled espera por elas). */
  pending(): Promise<void>[] {
    return [...this.runs.values()]
  }

  private async reconcileProject(projectId: string, everything: boolean): Promise<void> {
    const repo = this.deps.repo()
    if (!repo) return
    const since = everything ? null : this.deps.now() - RECONCILE_RECENT_MS
    const wanted = (e: HandoffEnvio): boolean =>
      e.projectId === projectId && rules.isReconcilable(e) && (since === null || (parseMs(e.updatedAt) ?? 0) >= since)
    const query = { projectIds: [projectId], statuses: [...rules.RECONCILE_STATUSES], limit: 1000 }
    const envios = (await repo.listHandoffEnvios(query)).filter(wanted)
    const convs = new Set(envios.map((e) => e.conversationId))
    const cwds: string[] = []
    // As conversas em memória do projeto entram mesmo sem envio a reconciliar: o
    // destino do retrabalho (cardInProgress) acompanha o Quadro.
    for (const [convId, s] of this.deps.states()) {
      if (s.projectId !== projectId) continue
      convs.add(convId)
      cwds.push(s.cwd)
    }
    if (convs.size === 0) return
    // Os cartões do projeto UMA vez por passada, para todas as conversas.
    const cards = await projectCards(this.deps.board, projectId, [...cwds, ...envios.map((e) => e.projectCwd)])
    if (!cards) return
    await Promise.allSettled(
      [...convs].map((convId) => this.deps.exclusive(convId, () => this.reconcileConversation(convId, wanted, cards)))
    )
  }

  /** Na fila da conversa: relê os envios dela e grava o que mudou nos `wanted`. */
  private async reconcileConversation(
    convId: string,
    wanted: (envio: HandoffEnvio) => boolean,
    cards: readonly BoardItem[]
  ): Promise<void> {
    const repo = this.deps.repo()
    if (!repo) return
    const s = this.deps.states().get(convId)
    const now = iso(this.deps.now())
    const sync = { now, poEnabled: this.deps.poEnabled() }
    const envios: HandoffEnvio[] = []
    let wrote = false
    for (let envio of await repo.listHandoffEnvios({ conversationId: convId })) {
      if (wanted(envio)) {
        const synced = await syncEnvio(repo, envio, cards, sync)
        envio = synced.envio
        // Turno rodando NESTE processo: o status do envio é do turno; só as entregas acompanham.
        const patch = rules.reconcileEnvioPatch(envio, cards, { now, turnRunning: s?.turnRunning ?? false })
        if (patch) envio = await repo.updateHandoffEnvio(envio.id, patch)
        wrote ||= synced.wrote || patch !== null
      }
      envios.push(envio)
    }
    if (s) {
      const current = currentEnvio(envios)
      s.cardInProgress = new Set(current ? rules.entregasWithCardInProgress(current, cards) : [])
    }
    if (wrote) this.deps.changed(convId)
  }
}
