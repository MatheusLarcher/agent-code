/**
 * O Quadro real dentro do motor do Escritório 3D: liga os dados (boardSync.ts)
 * à cena (boards.ts), o ponteiro ao papel e a dica/mensagem na tela.
 *
 *   feed(feed, layout)  projetos do escritório → Quadro (cwd) e se há alguém
 *                       trabalhando nele (o ritmo da leitura); títulos das conversas;
 *                       as abas; o projeto da parede (boardChoice.ts: filtro, aba,
 *                       conversa ativa; a coreografia de outro projeto visita e volta);
 *   setFilter(id)       o filtro de projeto do HUD (a parede mostra o filtrado);
 *   tick(now)           o tique do motor (só com a aba à vista): leitura vencida,
 *                       invariante de atraso (MAX_LAG_MS) e a mensagem que expira;
 *   pause / resume      aba fechada não lê; de volta, relê e vai direto ao estado atual;
 *   wrap / bind         os ganchos do ponteiro do motor com o quadro por cima: clique
 *                       no papel (cartão grande) e na pilha (lista da coluna), hover
 *                       (o papel sobe, brilha e mostra o nome da conversa) e o arrasto;
 *   open(id)            abre o cartão grande de fora (balão e selo da coreografia);
 *   attach(say, refeed) o balão do quadro (speech.say) e o refeed do modelo quando
 *                       muda o conjunto de salas com cartões (o PO aparece nelas).
 *
 * A fila de passos (`sync.steps`) é consumida pela COREOGRAFIA (boardStage.ts):
 * quem mudou o cartão vai ao quadro e o papel muda quando ele prende; sem
 * personagem, desliza sozinho com o selo (boardSeals.ts). Aba escondida, sala
 * fora da tela ou apagão: direto.
 *
 * Arrasto: só de perto (PERTO, com o texto à vista), papel parado e sem outro
 * arrasto em voo. Soltar em outra coluna chama `boardMove` (otimista); recusa
 * volta com tremidinha e a mensagem do main perto do quadro; mesma coluna ou
 * fora do quadro volta; Esc cancela (na captura: nem a tela nem o chat ouvem).
 */
import { Raycaster, Vector2, Vector3, type PerspectiveCamera } from 'three'
import type { OfficeFeed } from '../../office/adapter/feed'
import { principalKey, roomIdFor } from '../../office/adapter/model'
import { seedCss } from '../appearance'
import { BOARD_KEY, type EngineCallbacks, type Listen } from '../engineTypes'
import type { Office3DLayout } from '../layout'
import type { PointerHooks, PointerInput } from '../pointerInput'
import type { OfficeScene } from '../scene'
import { BoardChoice } from './boardChoice'
import { CARD_KEY, columnAt, parsePileKey, TAB_KEY } from './boardLayout'
import { BOARD_COLUMNS, columnIndex, columnLabel } from './boardModel'
import { appBoardApi, BoardSync, type BoardApi, type BoardRoomInput } from './boardSync'
import type { BoardView } from './boardView'
import { demoBoardApi } from './demoBoard'
import { BoardSeals } from './boardSeals'
import { BoardStage, type StageHost } from './boardStage'
import { BoardTips } from './boardTips'
import { onIcon } from './boardTitle'
import { PRIORITY, type Quip } from '../quips'
import { LOD_BOUNDS } from '../lod'
import { awayAnnounce } from './awayAnnounce'
import { clip } from './boardLines'

/** O resumo "desde que você saiu" fica no balão do PO por isto (ms). */
export const AWAY_SAY_MS = 9_000

export { BOARD_TOAST_MS } from './boardTips'

/** Um arrasto do usuário no 3D vale por isto (ms): o passo dele não reanima nem leva selo. */
const DRAG_GRACE_MS = 20_000

export class EngineBoard {
  private board: BoardSync
  /** O Quadro de verdade (o demo troca pelo falso e volta). */
  private readonly api: BoardApi | null
  /** As salas do último feed (o demo relê já com a fonte nova). */
  private rooms: BoardRoomInput[] = []
  private readonly titles = new Map<string, string>()
  private readonly pins = new Map<string, string>()
  private readonly ray = new Raycaster()
  private readonly ndc = new Vector2()
  private readonly head = new Vector3()
  private readonly local = { x: 0, y: 0 }
  private readonly tips: BoardTips
  /** Qual projeto a parede mostra (filtro, aba, conversa ativa, visita da coreografia). */
  private readonly choice = new BoardChoice()
  private grabbed: { roomId: string; id: string; lifted: boolean } | null = null
  private pointer: PointerInput | null = null
  private paused = false
  private disposed = false
  readonly stage: BoardStage
  private readonly seals: BoardSeals
  private readonly dragged = new Map<string, number>()
  private sayHook: (key: string, quip: Quip | null) => void = () => {}
  private refeed: () => void = () => {}
  /** Salas cujo Quadro tem cartões (o PO aparece nelas). */
  boardRooms: ReadonlySet<string> = new Set()

  constructor(
    private readonly scene: OfficeScene,
    container: HTMLElement,
    private readonly camera: PerspectiveCamera,
    listen: Listen,
    api: BoardApi | null | undefined,
    private readonly cb: EngineCallbacks,
    private readonly render: () => void,
    private readonly clock: () => number = () => Date.now()
  ) {
    this.api = api === undefined ? appBoardApi() : api
    this.stage = new BoardStage(this.host(), clock)
    this.seals = new BoardSeals(container, (id) => this.open(id))
    this.board = this.connect(this.api)
    this.scene.boards.onFresh = (id) => this.show(id, false)
    this.tips = new BoardTips(container, scene, camera, this.seals, (id) => this.sync.roomOf(id) ?? null)
    // Ícone de imagem que chegou depois: a faixa do título redesenha no próximo quadro.
    onIcon(() => this.render())
    // Esc com um papel pego: cancela (na captura, antes da tela do monitor e do chat).
    listen(
      window,
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || !this.grabbed || !this.pointer?.cancelGrab()) return
        e.preventDefault()
        e.stopPropagation()
      },
      { capture: true }
    )
  }

  /** Os dados do Quadro (leitura, espelho por sala e a fila de passos). */
  get sync(): BoardSync {
    return this.board
  }

  private connect(api: BoardApi | null): BoardSync {
    const sync = new BoardSync(api, this.clock)
    sync.onWall = (id) => {
      this.show(id, false)
      this.roomsChanged()
    }
    sync.onItems = () => {
      this.cb.onBoardChange?.()
      this.roomsChanged()
    }
    sync.steps.onPush = () => this.stage.push(sync.steps.drain())
    if (this.paused) sync.pause()
    return sync
  }

  /** Modo demonstração: as salas mostram o Quadro falso (demoBoard.ts); desligar volta ao real. */
  setDemo(on: boolean): void {
    this.pointer?.cancelGrab()
    this.stage.flush()
    this.seals.clear()
    this.board.dispose()
    this.board = this.connect(on ? demoBoardApi(this.clock) : this.api)
    this.board.setRooms(this.rooms)
  }

  /** Cor (CSS) da camisa do agente da conversa: o alfinete do papel. */
  private readonly pinOf = (convId: string): string => {
    let c = this.pins.get(convId)
    if (!c) this.pins.set(convId, (c = seedCss(principalKey(convId))))
    return c
  }

  /** Projetos do escritório → Quadro (cwd) e ritmo; títulos das conversas (dica e janela do cartão); abas e o projeto da parede. */
  feed(feed: OfficeFeed, layout: Office3DLayout): void {
    this.titles.clear()
    const rooms = new Map<string, BoardRoomInput>()
    for (const p of layout.projects) rooms.set(p.id, { id: p.id, cwd: '', busy: false })
    for (const c of feed.conversations) {
      this.titles.set(c.id, c.title)
      const r = rooms.get(roomIdFor(c.cwd))
      if (!r) continue
      if (!r.cwd) r.cwd = c.cwd
      if (feed.busyIds.has(c.id)) r.busy = true
    }
    this.rooms = [...rooms.values()].filter((r) => r.cwd !== '')
    this.board.setRooms(this.rooms)
    const info = new Map(layout.projects.map((p) => [p.id, p]))
    this.scene.boards.setTabs(this.rooms.map((r) => ({ id: r.id, name: info.get(r.id)?.name ?? r.id, icon: info.get(r.id)?.icon ?? null })))
    const active = feed.conversations.find((c) => c.id === feed.activeId)
    this.choice.setActive(feed.activeId, active?.cwd ? roomIdFor(active.cwd) : null)
    this.wall()
  }

  /** O filtro de projeto do HUD (null = Todos): a parede mostra o filtrado. */
  setFilter(id: string | null): void {
    this.choice.filter = id
    this.wall()
  }

  /** O projeto da parede (boardChoice.ts). */
  private wall(): void {
    this.scene.boards.show(this.choice.pick(this.rooms.map((r) => r.id)))
  }

  /** Título da conversa (null se ela não está mais no app). */
  title(convId: string): string | null {
    return this.titles.get(convId) ?? null
  }

  /** O tique do motor: leitura vencida, atraso máximo e a mensagem que expira. true se algo mudou na tela. */
  tick(now = this.clock()): boolean {
    this.sync.tick(now)
    let changed = this.stage.tick(now)
    if (this.announceAway()) changed = true
    if (this.seals.tick(now)) changed = true
    if (this.tips.tick(now)) changed = true
    for (const id of this.sync.roomIds) {
      const m = this.sync.mirror(id)
      const late = m ? m.overdue(now) : []
      if (!m || late.length === 0) continue
      for (const card of late) m.applyCard(card)
      this.show(id, true)
      changed = true
    }
    return changed
  }

  /**
   * O resumo "desde que você saiu" (awayAnnounce.ts): o PO do projeto diz a
   * versão curta quando a cabeça dele está na tela, sem zoom LONGE e com a
   * janela em foco — a câmera chegou na sala ou no quadro. Sem PO, espera.
   */
  private announceAway(): boolean {
    const list = awayAnnounce.pending()
    if (list.length === 0 || this.paused || this.disposed || document.hidden || !document.hasFocus()) return false
    let changed = false
    for (const a of list) {
      const key = `po:${roomIdFor(a.cwd)}`
      if (!this.inView(key)) continue
      this.stage.announce(key, clip(a.text), this.scene.character(key)?.model.convId ?? '', AWAY_SAY_MS)
      awayAnnounce.markSaid(a)
      changed = true
    }
    return changed
  }

  /** A cabeça do personagem projeta dentro da tela (a mesma regra do balão, speech.ts) e não está LONGE. */
  private inView(key: string): boolean {
    if (!this.scene.headWorldPosition(key, this.head)) return false
    if (this.head.distanceTo(this.camera.position) >= LOD_BOUNDS[1]) return false
    const p = this.head.project(this.camera)
    return p.z <= 1 && p.z >= -1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1
  }

  pause(): void {
    this.paused = true
    this.stage.flush()
    this.seals.clear()
    this.sync.pause()
    this.pointer?.cancelGrab()
  }

  resume(): void {
    this.paused = false
    this.sync.resume()
  }

  /** O balão do quadro e o refeed do modelo (o motor liga). */
  attach(say: (key: string, quip: Quip | null) => void, refeed: () => void): void {
    this.sayHook = say
    this.refeed = refeed
  }

  /** Clique no balão do quadro de um personagem: abre o cartão daquela fala. */
  openFromBubble(key: string): boolean {
    const id = this.stage.cardOf(key)
    return id !== null && this.open(id)
  }

  /** O conjunto de salas com cartões mudou: o modelo é refeito (o PO aparece ou sai). */
  private roomsChanged(): void {
    const next = new Set(this.sync.roomIds.filter((id) => (this.sync.mirror(id)?.real?.cards.length ?? 0) > 0))
    if (next.size === this.boardRooms.size && [...next].every((id) => this.boardRooms.has(id))) return
    this.boardRooms = next
    this.refeed()
  }

  /** O que o palco da coreografia pede (personagens, parede, falas, selos). */
  private host(): StageHost {
    const crowd = (): OfficeScene['crowd'] => this.scene.crowd
    return {
      brain: (key) => crowd().brains.get(key),
      boardDistance: (b) => {
        const f = b.roomId ? crowd().furniture(b.roomId) : undefined
        return f ? Math.hypot(b.x - f.board.x, b.z - f.board.pad.z) : null
      },
      live: () => !this.paused && !this.disposed && !document.hidden,
      dark: () => crowd().partyOn || this.scene.boardDark(),
      fromColumn: (s) => {
        const c = this.sync.mirror(s.roomId)?.card(s.cardId)
        return c ? columnIndex(c.status) : null
      },
      differs: (s) => {
        const m = this.sync.mirror(s.roomId)
        // Mudou de coluna e o papel já está nela (o arrasto otimista do usuário no 3D): nada a animar.
        if (s.kind === 'moved' && m?.card(s.cardId)?.status === s.toStatus) return false
        return m?.differs(s.cardId) ?? false
      },
      apply: (roomId, cardId) => {
        this.sync.mirror(roomId)?.applyCard(cardId)
        this.show(roomId, true)
      },
      say: (key, text, convId) =>
        this.sayHook(key, text ? { text, kind: 'board', icon: '📌', priority: PRIORITY.board, ttlMs: Infinity, convId } : null),
      seal: (_roomId, cardId, text, user) => {
        this.seals.add(cardId, text, user, this.clock())
        this.render()
      },
      draggedHere: (cardId) => {
        const at = this.dragged.get(cardId)
        return at !== undefined && this.clock() - at < DRAG_GRACE_MS
      },
      wall: () => this.scene.boards.shown,
      visit: (id) => {
        if (id !== null && !this.choice.canVisit(id)) return false
        this.choice.visit = id
        this.wall()
        return true
      }
    }
  }

  /** A parede da sala na cena; anima só com a aba à vista e a sala com luz. */
  private show(roomId: string, animate: boolean): void {
    const m = this.sync.mirror(roomId)
    if (!m || this.disposed) return
    const live = animate && !this.paused && !document.hidden && !this.scene.boardDark()
    this.scene.boards.apply(roomId, m, live, this.pinOf)
    this.render()
  }

  /** Abre o cartão grande (o balão e o selo da coreografia chamam): false se o cartão não está em sala nenhuma. */
  open(id: string): boolean {
    if (!this.sync.item(id)) return false
    this.cb.onBoardOpen?.({ kind: 'card', id, x: null, y: null })
    return true
  }

  /** Os ganchos do ponteiro do motor com o quadro por cima; `focused`: a chave em foco no motor. */
  wrap(h: PointerHooks, focused: () => string | null): PointerHooks {
    return {
      ...h,
      click: (key, at) => {
        // Fora do foco, o clique no quadro (fundo, papel, pilha) leva a câmera até ele; a aba ainda troca o projeto.
        if (key && focused() !== BOARD_KEY && (key === BOARD_KEY || key.startsWith(CARD_KEY) || key.startsWith(TAB_KEY) || parsePileKey(key))) {
          if (key.startsWith(TAB_KEY)) this.click(key, at)
          return h.click(BOARD_KEY, at)
        }
        if (!this.click(key, at)) h.click(key, at)
      },
      hover: (key) => {
        this.hover(key)
        h.hover(key)
      },
      grab: (key) => this.grab(key),
      grabMove: (x, y) => this.dragTo(x, y),
      grabDrop: (x, y) => this.drop(x, y),
      grabCancel: () => this.cancel(),
      cursor: (key) => (this.grabbable(key) ? 'grab' : 'pointer')
    }
  }

  bind(pointer: PointerInput): PointerInput {
    this.pointer = pointer
    return pointer
  }

  private click(key: string | null, at?: { x: number; y: number }): boolean {
    if (!key) return false
    const x = at?.x ?? null
    const y = at?.y ?? null
    if (key.startsWith(CARD_KEY)) {
      this.cb.onBoardOpen?.({ kind: 'card', id: key.slice(CARD_KEY.length), x, y })
      return true
    }
    // Aba: o projeto fica na parede até a conversa ativa mudar.
    if (key.startsWith(TAB_KEY)) {
      this.choice.choose(key.slice(TAB_KEY.length))
      this.wall()
      return true
    }
    const pile = parsePileKey(key)
    if (!pile) return false
    this.cb.onBoardOpen?.({ kind: 'pile', roomId: pile.roomId, status: pile.status, x, y })
    return true
  }

  /** Papel sob o mouse: sobe e brilha; a dica mostra o nome da conversa (na pilha, quantos e de que coluna). */
  private hover(key: string | null): void {
    const card = key?.startsWith(CARD_KEY) ? key.slice(CARD_KEY.length) : null
    const pile = key ? parsePileKey(key) : null
    this.scene.boards.hover(card)
    let text = ''
    if (card) {
      const item = this.sync.item(card)
      text = item ? (this.titles.get(item.conversationId) ?? 'Conversa removida') : ''
    } else if (pile) {
      const n = this.sync.mirror(pile.roomId)?.shown.filter((c) => c.status === pile.status).length ?? 0
      text = `${columnLabel(pile.status)}: ${n} cartões — clique para ver a lista`
    }
    this.tips.tip(card || pile ? key : null, text)
    this.render()
  }

  /** O papel dá para pegar: kanban de perto, papel parado, sem arrasto em voo nele. */
  private grabbable(key: string): { roomId: string; id: string } | null {
    if (!key.startsWith(CARD_KEY) || !this.sync.enabled || this.paused) return null
    const id = key.slice(CARD_KEY.length)
    const roomId = this.scene.boards.roomOfCard(id)
    if (!roomId || this.scene.boards.level(roomId) !== 0) return null
    const view = this.scene.boards.view(roomId)
    if (!view || view.busy(id) || this.sync.mirror(roomId)?.moving(id)) return null
    return { roomId, id }
  }

  private grab(key: string): boolean {
    const g = this.grabbable(key)
    this.grabbed = g ? { ...g, lifted: false } : null
    return g !== null
  }

  private toLocal(view: BoardView, x: number, y: number): boolean {
    this.ndc.set(x, y)
    this.ray.setFromCamera(this.ndc, this.camera)
    return view.localPoint(this.ray.ray, this.local)
  }

  private dragTo(x: number, y: number): void {
    const g = this.grabbed
    const view = g ? this.scene.boards.view(g.roomId) : undefined
    if (!g || !view) return this.cancel()
    if (!g.lifted) {
      if (!view.beginDrag(g.id)) return this.cancel()
      g.lifted = true
      this.hover(null)
    }
    if (this.toLocal(view, x, y)) view.dragTo(this.local.x, this.local.y)
    this.render()
  }

  private drop(x: number, y: number): void {
    const g = this.grabbed
    this.grabbed = null
    const view = g ? this.scene.boards.view(g.roomId) : undefined
    if (!g || !view) return
    const from = view.columnOf(g.id)
    const col = this.toLocal(view, x, y) ? columnAt(this.local.x, this.local.y) : null
    if (col === null || col === from) {
      view.endDrag()
      return this.render()
    }
    // Otimista: o espelho já põe o papel na coluna nova (no topo) antes da resposta do main.
    this.dragged.set(g.id, this.clock())
    const moving = this.sync.move(g.roomId, g.id, BOARD_COLUMNS[col].status)
    view.endDrag()
    this.render()
    void moving.then((res) => {
      if (this.disposed) return
      this.show(g.roomId, true)
      if (res.ok) return
      view.shake(g.id)
      this.say(g.roomId, res.message ?? 'Não foi possível mover o cartão.')
    })
  }

  private cancel(): void {
    const g = this.grabbed
    this.grabbed = null
    if (!g) return
    this.scene.boards.view(g.roomId)?.endDrag()
    this.render()
  }

  /** A mensagem (recusa do main) perto do quadro do projeto. */
  private say(roomId: string, text: string): void {
    this.tips.say(roomId, text, this.clock())
    this.render()
  }

  /** A mensagem em voo (testes e HUD). */
  get message(): string | null {
    return this.tips.message
  }

  /** A cada quadro: a dica, a mensagem e os selos sobre o quadro (boardTips.ts). */
  place(width: number, height: number): void {
    this.tips.place(width, height)
  }

  dispose(): void {
    this.disposed = true
    this.stage.flush()
    this.seals.dispose()
    this.sync.dispose()
    this.tips.dispose()
    onIcon(() => {})
    this.pointer = null
    this.grabbed = null
  }
}
