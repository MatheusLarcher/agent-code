/**
 * A fila do projeto no escritório 3D — PURO (sem three): a bandeja de papéis à
 * esquerda do quadro (trayView.ts) mostra uma folha por prompt esperando na
 * fila do projeto da parede, até TRAY_SHOWN (passou disso, "+K"), na ordem da
 * faixa "Próximos prompts" (nextPlans): a folha de cima é a próxima a sair.
 * Fila parada ou segurada pelo PO: clipe vermelho na folha de cima e o motivo
 * na dica ao passar o mouse.
 *
 * A fila vem de `handoffQueueList` (todas as pastas numa leitura, agrupadas
 * pela sala do escritório) a cada `handoff:changed` / `handoff:projectChanged`.
 * Não há evento "saiu para a conversa": o envio que some da fila e consta
 * como enviado no acompanhamento da conversa dona (`handoffList`) é o que o
 * despachante soltou — a folha que o PO leva até a mesa do agente.
 */
import type { HandoffChangedMsg, HandoffListRequest, HandoffListResult, HandoffQueueListRequest, HandoffQueueListResult } from '@shared/api'
import type { HandoffProjectSnapshot } from '@shared/handoffProject'
import { isEnvioRemoved, isEnvioSent, type HandoffQueueItem } from '@shared/handoffTracking'
import { roomIdFor } from '../../office/adapter/model'
import { nextPlans, promptState } from '../../planning/nextPrompts'

/** Folhas à vista na bandeja; o resto vira "+K". */
export const TRAY_SHOWN = 4
/** A chave de pick da bandeja (a dica com o motivo da fila parada). */
export const TRAY_KEY = 'office-tray'
/** Espera os avisos da fila assentarem antes de reler (vários por envio). */
export const TRAY_DEBOUNCE_MS = 250

/** O pedaço do window.api que a bandeja usa. */
export interface TrayApi {
  handoffQueueList(req?: HandoffQueueListRequest): Promise<HandoffQueueListResult>
  handoffList(req?: HandoffListRequest): Promise<HandoffListResult>
  onHandoffChanged(cb: (msg: HandoffChangedMsg) => void): () => void
  onHandoffProjectChanged(cb: (snapshot: HandoffProjectSnapshot) => void): () => void
  /** Só a fila falsa da demo: anda com o tique do motor (sem timer próprio). */
  tick?(now: number): void
}

/** O window.api do app, se tiver tudo o que a bandeja usa; null fora do app (testes, harness). */
export function appTrayApi(): TrayApi | null {
  const api = (globalThis as { window?: { api?: Partial<TrayApi> } }).window?.api
  const fns = [api?.handoffQueueList, api?.handoffList, api?.onHandoffChanged, api?.onHandoffProjectChanged]
  return api && fns.every((f) => typeof f === 'function') ? (api as TrayApi) : null
}

/** A fila por sala do escritório, cada uma na ordem da faixa (a primeira é a próxima a sair). */
export function trayRooms(items: readonly HandoffQueueItem[]): Map<string, HandoffQueueItem[]> {
  const byRoom = new Map<string, HandoffQueueItem[]>()
  for (const item of items) {
    const room = roomIdFor(item.projectCwd)
    byRoom.set(room, [...(byRoom.get(room) ?? []), item])
  }
  for (const [room, list] of byRoom) byRoom.set(room, nextPlans(list, null).flatMap((p) => p.prompts.map((x) => x.item)))
  return byRoom
}

export interface TrayLook {
  /** Folhas na bandeja (até TRAY_SHOWN). */
  sheets: number
  /** O "+K": quantas passaram de TRAY_SHOWN. */
  more: number
  /** A folha de cima está parada ou segurada pelo PO: o clipe vermelho. */
  stopped: boolean
  /** A dica ao passar o mouse ('' sem folha). */
  tip: string
}

/**
 * Como a bandeja fica com esta fila. `leaving` = a folha que já saiu da fila e
 * ainda espera o PO pegar (continua por cima, sem clipe).
 */
export function trayLook(list: readonly HandoffQueueItem[], leaving: HandoffQueueItem | null = null): TrayLook {
  const n = list.length + (leaving ? 1 : 0)
  const top = leaving ?? list[0] ?? null
  const stopped = !leaving && !!top && (top.estado === 'parada' || top.estado === 'segurada')
  let tip = ''
  if (leaving) tip = `O PO está levando o próximo prompt para "${leaving.conversationTitle}"`
  else if (top && stopped) tip = `Fila ${promptState(top)}`
  else if (top) tip = `${n === 1 ? '1 prompt' : `${n} prompts`} na fila — o próximo vai para "${top.conversationTitle}" (${top.planTitulo})`
  if (tip && n > 1 && (leaving || stopped)) tip += ` · ${n} na fila`
  return { sheets: Math.min(n, TRAY_SHOWN), more: Math.max(0, n - TRAY_SHOWN), stopped, tip }
}

/** Os envios que saíram da fila entre duas leituras (na ordem em que estavam). */
export function leftQueue(prev: readonly HandoffQueueItem[], next: readonly HandoffQueueItem[]): HandoffQueueItem[] {
  const ids = new Set(next.map((i) => i.envioId))
  return prev.filter((i) => !ids.has(i.envioId))
}

/**
 * A fila lida do app: relê a cada aviso (com TRAY_DEBOUNCE_MS) e avisa quando
 * um envio saiu para a conversa (`onRelease`). Sem API, fica vazia.
 */
export class QueueTraySync {
  private rooms = new Map<string, HandoffQueueItem[]>()
  private readonly offs: Array<() => void> = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private seq = 0
  private read0 = false
  private disposed = false
  /** A fila de alguma sala mudou (a bandeja redesenha). */
  onChange: () => void = () => {}
  /** O despachante soltou este envio (saiu da fila e consta como enviado). */
  onRelease: (roomId: string, item: HandoffQueueItem) => void = () => {}

  constructor(private readonly api: TrayApi | null) {
    if (!api) return
    this.offs.push(
      api.onHandoffChanged(() => this.soon()),
      api.onHandoffProjectChanged(() => this.soon())
    )
    void this.read()
  }

  /** A fila da sala, na ordem da faixa. */
  list(roomId: string | null): readonly HandoffQueueItem[] {
    return (roomId && this.rooms.get(roomId)) || []
  }

  /** O tique do motor (a fila falsa da demo anda com ele). */
  tick(now: number): void {
    if (!this.disposed) this.api?.tick?.(now)
  }

  private soon(ms = TRAY_DEBOUNCE_MS): void {
    if (this.disposed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.read()
    }, ms)
  }

  /**
   * Relê a fila; o que sumiu e saiu de verdade vira `onRelease` — antes da fila nova valer, para a folha
   * que vai ser entregue não sumir e voltar. Uma leitura mais nova vence (esta é descartada).
   */
  async read(): Promise<void> {
    const api = this.api
    if (!api || this.disposed) return
    const seq = ++this.seq
    const res = await api.handoffQueueList().catch(() => null)
    if (!res?.ok || seq !== this.seq || this.disposed) return
    const next = trayRooms(res.items)
    const released: Array<[string, HandoffQueueItem]> = []
    if (this.read0) {
      for (const [room, prev] of this.rooms) for (const item of leftQueue(prev, next.get(room) ?? [])) if (await this.sent(item)) released.push([room, item])
      if (seq !== this.seq || this.disposed) return
    }
    this.read0 = true
    this.rooms = next
    for (const [room, item] of released) this.onRelease(room, item)
    this.onChange()
  }

  /** O envio saiu para a conversa (e não foi tirado da fila pelo usuário). */
  private async sent(item: HandoffQueueItem): Promise<boolean> {
    const res = await this.api?.handoffList({ conversationId: item.conversationId }).catch(() => null)
    const envio = res?.ok ? res.envios.find((e) => e.id === item.envioId) : undefined
    return !!envio && !this.disposed && isEnvioSent(envio) && !isEnvioRemoved(envio)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const off of this.offs) off()
    this.offs.length = 0
    this.onChange = () => {}
    this.onRelease = () => {}
  }
}
