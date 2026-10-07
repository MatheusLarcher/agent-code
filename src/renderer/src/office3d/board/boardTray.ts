/**
 * A bandeja da fila ligada ao escritório: a fila do projeto da parede
 * (queueTray.ts) desenhada na bandeja (trayView.ts) e a ENTREGA — quando o
 * despachante solta o próximo prompt, o PO da sala pega a folha de cima, leva
 * até a mesa do agente da conversa (o caminho da visita, brainBoard.ts) e volta
 * ao lugar. A folha fica na bandeja até ele pegar.
 *
 * Sem PO livre (fora do escritório, numa ida ao quadro, permissão, apagão…),
 * agente sem mesa ou projeto fora da parede: a folha só some. Uma ida ao
 * quadro tem a vez — se o palco der outra tarefa ao PO no meio da entrega, a
 * entrega acaba ali (a folha conta como entregue).
 */
import type { HandoffQueueItem } from '@shared/handoffTracking'
import { principalKey } from '../../office/adapter/model'
import type { Brain } from '../brainBody'
import { DESK, errandBlocked, newErrand, TRAY, visitSpotOf, type BoardSpot, type Errand, type ErrandBeat } from '../brainBoard'
import { QUEUE_TRAY } from '../officePlan'
import { demoTrayApi } from './demoTray'
import { QueueTraySync, trayLook, type TrayApi, type TrayLook } from './queueTray'

/** Uma entrega que passa disto (ms) é largada (caminho preso): a folha conta como entregue. */
export const DELIVERY_MAX_MS = 60_000

export interface TrayHost {
  brain(key: string): Brain | undefined
  /** O projeto que está na parede (a bandeja mostra a fila dele). */
  shown(): string | null
  /** A bandeja na cena (null sem escritório). */
  view(): { set(look: TrayLook): void } | null
  /** Animar agora? (aba à vista, sem pausa, luz acesa e sem festa). */
  live(): boolean
}

const beat = (action: ErrandBeat['action'], dur: number, prop: ErrandBeat['prop'], fire = false): ErrandBeat => ({ action, dur, prop, fire })

/** De pé diante da bandeja, olhando a folha de cima. */
export const TRAY_STAND: Readonly<BoardSpot> = { x: QUEUE_TRAY.x, z: QUEUE_TRAY.standZ, yaw: 0, lx: QUEUE_TRAY.x, ly: QUEUE_TRAY.h, lz: QUEUE_TRAY.z }

/** A ida da entrega: pega a folha (o instante em que ela sai da bandeja) e deixa na mesa do agente `target`. */
export function deliveryErrand(target: string, desk: BoardSpot): Errand {
  return newErrand(
    [
      { col: TRAY, beats: [beat('grabBook', 0.8, null, true), beat('idle', 0.25, 'note')], step: -1, fired: false, at: { ...TRAY_STAND } },
      { col: DESK, beats: [beat('talk', 0.8, 'note'), beat('stick', 0.9, 'note', true), beat('idle', 0.3, null)], step: -1, fired: false, visit: target, at: { ...desk } }
    ],
    'walk'
  )
}

interface Delivery {
  roomId: string
  key: string
  item: HandoffQueueItem
  errand: Errand
  startedAt: number
  /** A bandeja já mostra a folha fora (o PO pegou). */
  picked: boolean
}

export class BoardTray {
  private sync: QueueTraySync
  private delivery: Delivery | null = null
  private readonly desk: BoardSpot = { x: 0, z: 0, yaw: 0, lx: 0, ly: 0, lz: 0 }
  private dirty = true
  /** O projeto da parede no último desenho (trocou: a bandeja mostra a fila do novo). */
  private drawnFor: string | null = null

  constructor(
    private readonly host: TrayHost,
    private readonly api: TrayApi | null,
    private readonly clock: () => number = () => Date.now()
  ) {
    this.sync = this.connect(api)
  }

  private connect(api: TrayApi | null): QueueTraySync {
    const sync = new QueueTraySync(api)
    sync.onChange = () => (this.dirty = true)
    sync.onRelease = (roomId, item) => this.release(roomId, item)
    return sync
  }

  /** Demonstração: a fila falsa (demoTray.ts); desligar volta à do app. */
  setDemo(on: boolean): void {
    this.end()
    this.sync.dispose()
    this.sync = this.connect(on ? demoTrayApi(this.clock) : this.api)
    this.dirty = true
  }

  /** A folha que saiu da fila e ainda espera o PO pegar (fica por cima, na bandeja). */
  private get leaving(): HandoffQueueItem | null {
    const d = this.delivery
    return d && !d.picked && d.roomId === this.host.shown() ? d.item : null
  }

  /** A bandeja como está agora (a do projeto da parede). */
  get look(): TrayLook {
    return trayLook(this.sync.list(this.host.shown()), this.leaving)
  }

  /** A dica ao passar o mouse na bandeja. */
  tip(): string {
    return this.look.tip || 'Fila vazia: nenhum prompt esperando'
  }

  /** O despachante soltou `item`: o PO da sala vai entregar a folha (se puder). */
  private release(roomId: string, item: HandoffQueueItem): void {
    if (this.delivery || roomId !== this.host.shown() || !this.host.live()) return
    const key = `po:${roomId}`
    const po = this.host.brain(key)
    const target = principalKey(item.conversationId)
    if (!po || po.role !== 'fixed' || po.errand || errandBlocked(po)) return
    if (!visitSpotOf(this.host.brain(target), this.desk, false)) return
    const errand = deliveryErrand(target, this.desk)
    po.errand = errand
    this.delivery = { roomId, key, item, errand, startedAt: this.clock(), picked: false }
    this.dirty = true
  }

  /** O tique do motor: acompanha a entrega e redesenha a bandeja. true se algo mudou na tela. */
  tick(now = this.clock()): boolean {
    this.sync.tick(now)
    const d = this.delivery
    if (d) {
      const b = this.host.brain(d.key)
      if (!d.picked && d.errand.stops[0].fired) {
        d.picked = true
        this.dirty = true
      }
      if (!b || b.errand !== d.errand || d.errand.state === 'done' || d.errand.state === 'aborted' || now - d.startedAt > DELIVERY_MAX_MS) this.end()
    }
    const shown = this.host.shown()
    if (!this.dirty && shown === this.drawnFor) return false
    this.dirty = false
    this.drawnFor = shown
    this.host.view()?.set(this.look)
    return true
  }

  /** Larga a entrega (acabou, foi abortada ou o palco deu outra ida ao PO). */
  private end(): void {
    const d = this.delivery
    if (!d) return
    this.delivery = null
    this.dirty = true
    const b = this.host.brain(d.key)
    if (!b || b.errand !== d.errand) return
    if (d.errand.state !== 'done') d.errand.state = 'aborted'
    b.errand = null
    b.prop = null
  }

  /** A entrega em curso (testes e validação). */
  get delivering(): { key: string; target: string; picked: boolean } | null {
    const d = this.delivery
    return d ? { key: d.key, target: d.errand.stops[1].visit ?? '', picked: d.picked } : null
  }

  dispose(): void {
    this.end()
    this.sync.dispose()
  }
}
