/**
 * O Quadro real de cada sala do Escritório 3D, lido pelas MESMAS chamadas da
 * aba Quadro (sem IPC nem código novo no main):
 *
 *   boardList({ projectCwd })  uma chamada por sala (o cwd é o projeto dela);
 *   onBoardChanged             recarrega a sala do projeto que mudou;
 *   poll                       5 s com alguém trabalhando na sala, 30 s parada;
 *   boardItemEvents(id)        só dos cartões que mudaram, para o autor e o motivo.
 *
 * Nunca mais rápido que o painel: o `list()` do main faz a faxina de
 * concluídos velhos a cada chamada. Leitura em voo absorve os pedidos que
 * chegarem (no fim, UMA leitura a mais). O ritmo vem de `tick`, que o motor só
 * chama com a aba Escritório à vista: pausado, nada é lido; ao voltar, cada
 * sala relê e a parede vai direto ao estado atual (sem replay), como na 1ª
 * leitura e na sala que acabou de surgir.
 *
 * Cada retrato novo vira um diff (boardModel.ts) e os passos, com autor e
 * texto, vão para a fila `steps` — o ponto de extensão de quem anima.
 */
import type { BoardItem, BoardItemEvent, BoardItemStatus, ProjectBoard } from '@shared/ipc'
import { BoardMirror } from './boardMirror'
import { boardSnap, BoardStepQueue, diffBoard, lastEventAt, stepsFor, type BoardChange, type BoardStep } from './boardModel'

export const POLL_BUSY_MS = 5_000
export const POLL_IDLE_MS = 30_000
/** A leitura dos eventos de um cartão desiste depois disto: o passo sai com texto neutro. */
export const EVENTS_TIMEOUT_MS = 3_000
/** No máximo tantas linhas do tempo lidas por retrato (as mais recentes); o resto sai neutro. */
export const MAX_EVENT_READS = 8

/** O pedaço do window.api que o quadro 3D usa. */
export interface BoardApi {
  boardList(query: { projectCwd: string }): Promise<ProjectBoard>
  boardItemEvents(boardItemId: string): Promise<BoardItemEvent[]>
  onBoardChanged(cb: (msg: { projectId: string }) => void): () => void
  boardMove(id: string, toStatus: BoardItemStatus): Promise<{ ok: boolean; message?: string }>
  boardDismiss(id: string, dismissed: boolean): Promise<BoardItem | null>
  /** Só o Quadro falso da demo: anda com o tique do motor (sem timer próprio). */
  tick?(now: number): void
}

/** O window.api do app, se tiver tudo o que o quadro usa; null fora do app (testes). */
export function appBoardApi(): BoardApi | null {
  const api = (globalThis as { window?: { api?: Partial<BoardApi> } }).window?.api
  const fns = [api?.boardList, api?.boardItemEvents, api?.onBoardChanged, api?.boardMove, api?.boardDismiss]
  return api && fns.every((f) => typeof f === 'function') ? (api as BoardApi) : null
}

/** Uma sala do escritório: o projeto (cwd) e se há alguém trabalhando nela. */
export interface BoardRoomInput {
  id: string
  cwd: string
  busy: boolean
}

interface RoomState {
  readonly id: string
  cwd: string
  busy: boolean
  projectId: string | null
  readonly mirror: BoardMirror
  items: Map<string, BoardItem>
  /** Cartões que já sumiram desta sala (quem reaparece "voltou"). */
  readonly gone: Set<string>
  /** Cartão → último `at` de evento já visto. */
  readonly seen: Map<string, string>
  lastFetch: number
  inFlight: boolean
  again: boolean
  /** A próxima leitura vai direto para a parede (volta da pausa). */
  direct: boolean
}

const byAt = (a: BoardStep, b: BoardStep): number => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)

export class BoardSync {
  /** A fila de passos (autor, texto, ordem real). */
  readonly steps = new BoardStepQueue()
  private readonly rooms = new Map<string, RoomState>()
  private paused = false
  private disposed = false
  private readonly off: (() => void) | null
  /** A parede de uma sala mudou sem passo (1ª leitura, volta, indisponível): a cena redesenha. */
  onWall: (roomId: string) => void = () => {}
  /** Os dados dos cartões mudaram (a janela do cartão acompanha). */
  onItems: () => void = () => {}

  constructor(
    private readonly api: BoardApi | null,
    private readonly clock: () => number = () => Date.now()
  ) {
    this.off = api ? api.onBoardChanged((m) => this.changed(m?.projectId)) : null
  }

  get enabled(): boolean {
    return this.api !== null
  }

  /** As salas do escritório agora. Sala nova lê já (direto); a que saiu é esquecida. */
  setRooms(rooms: readonly BoardRoomInput[]): void {
    const ids = new Set<string>()
    for (const r of rooms) {
      ids.add(r.id)
      const cur = this.rooms.get(r.id)
      if (cur) {
        if (cur.cwd !== r.cwd) {
          cur.cwd = r.cwd
          cur.direct = true
          this.request(cur)
        }
        cur.busy = r.busy
        continue
      }
      const st: RoomState = {
        id: r.id,
        cwd: r.cwd,
        busy: r.busy,
        projectId: null,
        mirror: new BoardMirror(),
        items: new Map(),
        gone: new Set(),
        seen: new Map(),
        lastFetch: -Infinity,
        inFlight: false,
        again: false,
        direct: true
      }
      this.rooms.set(r.id, st)
      this.request(st)
    }
    for (const id of [...this.rooms.keys()]) if (!ids.has(id)) this.rooms.delete(id)
  }

  /** Relógio (o tique do motor, só com a aba à vista): lê as salas cujo intervalo venceu. */
  tick(now = this.clock()): void {
    if (this.paused || this.disposed) return
    this.api?.tick?.(now)
    for (const r of this.rooms.values()) {
      if (r.inFlight) continue
      if (now - r.lastFetch >= (r.busy ? POLL_BUSY_MS : POLL_IDLE_MS)) void this.read(r)
    }
  }

  /** Aba fechada: nada é lido (o evento do main só anota). */
  pause(): void {
    this.paused = true
  }

  /** Aba de volta: cada sala relê e a parede vai direto ao estado atual. */
  resume(): void {
    if (!this.paused) return
    this.paused = false
    for (const r of this.rooms.values()) {
      r.direct = true
      this.request(r)
    }
  }

  /** Relê a sala agora (ou logo depois da leitura em voo). */
  refresh(roomId: string): void {
    const r = this.rooms.get(roomId)
    if (r) this.request(r)
  }

  mirror(roomId: string): BoardMirror | undefined {
    return this.rooms.get(roomId)?.mirror
  }

  get roomIds(): string[] {
    return [...this.rooms.keys()]
  }

  /** O cartão completo (o da última leitura), para a janela do cartão. */
  item(cardId: string): BoardItem | undefined {
    for (const r of this.rooms.values()) {
      const it = r.items.get(cardId)
      if (it) return it
    }
    return undefined
  }

  /** A sala que mostra o cartão. */
  roomOf(cardId: string): string | undefined {
    for (const r of this.rooms.values()) if (r.items.has(cardId)) return r.id
    return undefined
  }

  /**
   * O arrasto do usuário: a parede já mostra o papel na coluna nova (otimista)
   * e o `boardMove` do main decide (manda o agente começar, interrompe, ou
   * recusa sem sessão viva). Recusado, o papel volta e a mensagem sobe.
   */
  async move(roomId: string, cardId: string, toStatus: BoardItemStatus): Promise<{ ok: boolean; message?: string }> {
    const r = this.rooms.get(roomId)
    if (!r || !this.api || !r.mirror.userMove(cardId, toStatus)) return { ok: false }
    let result: { ok: boolean; message?: string }
    try {
      result = await this.api.boardMove(cardId, toStatus)
    } catch (e) {
      result = { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
    if (this.disposed) return result
    r.mirror.endUserMove(cardId, result.ok, this.clock())
    if (!result.ok) result = { ok: false, message: result.message || 'Não foi possível mover o cartão.' }
    else this.request(r)
    return result
  }

  /** A linha do tempo de um cartão, pela mesma fonte do quadro ([] sem fonte ou se a leitura falhar). */
  async events(cardId: string): Promise<BoardItemEvent[]> {
    return (await this.readEvents(cardId)) ?? []
  }

  /** Dispensa/restaura pela mesma fonte do quadro; a sala relê. */
  async dismiss(cardId: string, dismissed: boolean): Promise<void> {
    if (!this.api) return
    try {
      await this.api.boardDismiss(cardId, dismissed)
    } finally {
      const room = this.roomOf(cardId)
      if (room) this.refresh(room)
    }
  }

  dispose(): void {
    this.disposed = true
    this.off?.()
    this.rooms.clear()
    this.steps.clear()
    this.onWall = () => {}
    this.onItems = () => {}
  }

  /** `board:changed`: relê as salas desse projeto (e as que ainda não sabem o projeto: quadro vazio). */
  private changed(projectId: string | undefined): void {
    for (const r of this.rooms.values()) {
      if (r.projectId === null || r.projectId === projectId) this.request(r)
    }
  }

  private request(r: RoomState): void {
    if (this.disposed || !this.api) return
    if (this.paused) {
      r.direct = true
      r.lastFetch = -Infinity
      return
    }
    if (r.inFlight) r.again = true
    else void this.read(r)
  }

  private async read(r: RoomState): Promise<void> {
    if (!this.api) return
    r.inFlight = true
    r.again = false
    r.lastFetch = this.clock()
    try {
      let board: ProjectBoard | null
      try {
        board = await this.api.boardList({ projectCwd: r.cwd })
      } catch {
        board = null
      }
      if (this.disposed || this.rooms.get(r.id) !== r) return
      // Leitura que falhou (IPC): fica o que estava; sem nada antes, indisponível.
      if (!board || !Array.isArray(board.items)) {
        if (!r.mirror.loaded) this.direct(r, { available: false, items: [] })
        return
      }
      const pid = board.items[0]?.projectId
      if (pid) r.projectId = pid
      const prev = r.mirror.real
      const next = boardSnap(board)
      if (r.direct || !prev || !prev.available || !next.available) return this.direct(r, board)
      r.items = new Map(board.items.map((i) => [i.id, i]))
      const changes = diffBoard(prev, next, r.gone)
      r.mirror.setTarget(next, this.clock())
      if (changes.length === 0) return
      for (const ch of changes) {
        if (ch.kind === 'removed') r.gone.add(ch.card.id)
        else if (ch.kind === 'restored') r.gone.delete(ch.card.id)
      }
      this.onItems()
      const steps = await this.stepsOf(r, changes)
      if (this.disposed || this.rooms.get(r.id) !== r) return
      this.steps.push(steps)
    } finally {
      r.inFlight = false
      if (r.again && !this.paused && !this.disposed && this.rooms.get(r.id) === r) void this.read(r)
    }
  }

  /** A parede vai direto ao retrato (sem passos): 1ª leitura, volta da pausa, indisponível. */
  private direct(r: RoomState, board: ProjectBoard): void {
    r.direct = false
    r.items = new Map(board.items.map((i) => [i.id, i]))
    const snap = boardSnap(board)
    r.mirror.setTarget(snap, this.clock(), true)
    for (const c of snap.cards) {
      const seen = r.seen.get(c.id)
      if (!seen || c.updatedAt > seen) r.seen.set(c.id, c.updatedAt)
      r.gone.delete(c.id)
    }
    this.onWall(r.id)
    this.onItems()
  }

  /** Lê a linha do tempo dos cartões que mudaram (os mais recentes primeiro) e monta os passos na ordem real. */
  private async stepsOf(r: RoomState, changes: BoardChange[]): Promise<BoardStep[]> {
    const ordered = [...changes].sort((a, b) => (a.card.updatedAt < b.card.updatedAt ? 1 : a.card.updatedAt > b.card.updatedAt ? -1 : 0))
    const reads = await Promise.all(ordered.map((ch, i) => (i < MAX_EVENT_READS ? this.readEvents(ch.card.id) : Promise.resolve(null))))
    const out: BoardStep[] = []
    ordered.forEach((ch, i) => {
      const since = r.seen.get(ch.card.id) ?? ch.prev?.updatedAt ?? null
      // Só o que o retrato já mostra: evento mais novo que ele fica para o próximo diff.
      const all = reads[i]
      const events = all && ch.kind !== 'removed' ? all.filter((e) => e.at <= ch.card.updatedAt) : all
      out.push(...stepsFor(r.id, ch, events, since))
      const last = lastEventAt(events, ch.kind === 'removed' ? since : ch.card.updatedAt)
      if (last) r.seen.set(ch.card.id, last)
    })
    return out.sort(byAt)
  }

  /** A linha do tempo com prazo: null se falhou ou passou de EVENTS_TIMEOUT_MS. */
  private async readEvents(id: string): Promise<BoardItemEvent[] | null> {
    if (!this.api) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), EVENTS_TIMEOUT_MS)
      })
      const read = this.api.boardItemEvents(id).then((list) => (Array.isArray(list) ? list : null))
      return await Promise.race([read, timeout])
    } catch {
      return null
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
