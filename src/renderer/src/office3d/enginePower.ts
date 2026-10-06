/**
 * A energia do escritório dentro do motor (power.ts): o PowerTracker relê a
 * janela de 5h a cada feed e a cada tique (com o override de DEV), a cena
 * recebe a leitura e o evento (usina, luz, apagão, festa), as falas recebem o
 * que precisam dela (com os papéis da festa) e `onPower` avisa a barra só
 * quando o que ela mostra muda.
 */
import type { OfficeFeed } from '../office/adapter/feed'
import { bankSig } from './accountBank'
import type { OfficePower, PowerEvent } from './power'
import { PowerTracker } from './powerTracker'
import type { PowerQuipInput } from './quips'
import type { OfficeScene } from './scene'

export class EnginePower {
  private readonly tracker = new PowerTracker()
  /** O que a barra mostra (só avisa quando muda). */
  private sig = '-'
  /** Resultado do último tique (reaproveitado: o tique não aloca). */
  private readonly out: { event: PowerEvent | null; changed: boolean } = { event: null, changed: false }

  constructor(
    private readonly scene: OfficeScene,
    private readonly onPower: (power: OfficePower | null) => void
  ) {}

  /** A energia em vigor (com o override de DEV, se houver). */
  get power(): OfficePower | null {
    return this.tracker.power
  }

  /**
   * Leitura do feed; a cena recebe já — antes do sync, para a sala no escuro
   * montar com a tela preta. `t` = relógio da cena (s). `catchUp` (volta da
   * pausa): o nível novo vale, mas sem evento — nada de cascata de apagar ou
   * acender nem de "Acabou a luz!" por algo que aconteceu com a aba fechada.
   */
  read(feed: OfficeFeed, wallNow: number, t: number, catchUp = false): PowerEvent | null {
    const changed = this.tracker.update(feed, wallNow)
    const event = catchUp ? null : changed
    this.scene.setPower(this.tracker.power, event, t, wallNow)
    return event
  }

  /** O relógio andou sem feed (reset que passou, override): relê e, se mudou o que importa, passa à cena. */
  tick(feed: OfficeFeed | null, now: number, t: number): { readonly event: PowerEvent | null; readonly changed: boolean } {
    const before = this.tracker.power
    const event = feed || this.tracker.overridden ? this.tracker.update(feed, now) : null
    const after = this.tracker.power
    const changed =
      event !== null || before?.level !== after?.level || before?.pct !== after?.pct || before?.resetsAt !== after?.resetsAt || before?.drainPerMin !== after?.drainPerMin || before?.accountId !== after?.accountId || bankSig(before?.bank ?? []) !== bankSig(after?.bank ?? [])
    if (changed) this.scene.setPower(after, event, t, now)
    this.out.event = event
    this.out.changed = changed
    return this.out
  }

  /** Só DEV (Ctrl+Alt+Shift+B): força o próximo nível, em ciclo. */
  cycle(now: number, t: number): PowerEvent | null {
    const event = this.tracker.cycle(now)
    this.scene.setPower(this.tracker.power, event, t, now)
    return event
  }

  /** O que as falas precisam da energia (com os papéis da festa); null sem a janela de 5h. */
  quip(event: PowerEvent | null): PowerQuipInput | null {
    const p = this.tracker.power
    return p ? { level: p.level, pct: p.pct, resetsAt: p.resetsAt, event, roles: this.scene.crowd.partyRoles } : null
  }

  /** Avisa a barra só quando muda o que ela mostra. */
  emit(): void {
    const p = this.tracker.power
    const sig = p ? `${p.pct}|${p.level}|${p.resetsAt}|${p.drainPerMin}|${p.accountId}|${p.unread ? 1 : 0}|${bankSig(p.bank)}` : ''
    if (sig === this.sig) return
    this.sig = sig
    this.onPower(p)
  }
}
