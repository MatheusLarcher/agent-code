/**
 * Fila de animações por personagem (card dec-todas-animacoes, "Regras gerais").
 *
 * - Uma animação por personagem de cada vez; as outras esperam em fila, na
 *   ordem em que chegaram. A próxima só começa quando a atual termina.
 * - Pedido vence enfeite: '…' (permissão) ou '?' (pergunta) no personagem
 *   interrompem a animação NA HORA e descartam a fila dele. A exceção é a
 *   animação que nasce do próprio pedido (keepOnWaiting: o vigia com a mão).
 * - Destino ausente (walk devolve false) não trava: a animação segue "no
 *   lugar", só com os balões/legendas/adereços, e pula as caminhadas seguintes.
 * - 'until' espera um sinal externo (fim da trilha, fim do diagnóstico); sinal
 *   que chega antes do passo fica guardado e libera o passo na hora.
 *
 * Pura quanto ao motor: tudo que toca no escritório passa pelo AnimStage.
 */
import type { DestinationRole, PropKind } from '../engine/types'

export type AnimName =
  | 'delegacao'
  | 'devolucao'
  | 'revisao'
  | 'veredito'
  | 'po-quadro'
  | 'po-fim'
  | 'vigia-mao'
  | 'memorista'
  | 'memorista-fim'
  | 'cafe'
  | 'cracha'

/** Para onde andar: um assento (fica ao lado dele) ou um destino da planta. */
export type AnimTarget = { kind: 'seat'; seatId: string } | { kind: 'destination'; papel: DestinationRole }

export type AnimStep =
  | { do: 'prop'; prop: PropKind | null; tint?: string | null }
  | { do: 'walk'; to: AnimTarget | null }
  | { do: 'wait'; sec: number }
  | { do: 'until'; signal: string; timeoutSec?: number }
  | { do: 'caption'; text: string; sec: number }
  | { do: 'call'; fn: () => void }
  /** Volta ao lugar dele (assento ou destino de origem). */
  | { do: 'home' }

export interface Anim {
  name: AnimName
  steps: AnimStep[]
  /** Não é interrompida por '…'/'?' (nasce de um pedido). */
  keepOnWaiting?: boolean
}

/** O que a fila precisa do escritório. O adaptador implementa sobre o motor. */
export interface AnimStage {
  exists(id: number): boolean
  /** Mostra '…' ou '?' agora. */
  waiting(id: number): boolean
  /** Começa a andar; false = destino ausente ou inalcançável (nada muda). */
  walk(id: number, to: AnimTarget): boolean
  walking(id: number): boolean
  home(id: number): boolean
  setProp(id: number, prop: PropKind | null, tint?: string | null): void
  caption(id: number, text: string, sec: number): void
  pin(id: number, on: boolean): void
}

interface Running {
  anim: Anim
  step: number
  /** O passo atual já foi iniciado (caminhada pedida, relógio armado…). */
  started: boolean
  timer: number
  moving: boolean
  /** Destino ausente: segue só com balões, sem caminhar. */
  stranded: boolean
}

interface Slot {
  current: Running | null
  queue: Anim[]
  signals: Set<string>
}

/** Prazo padrão de um 'until' sem timeoutSec: ninguém fica preso para sempre. */
export const UNTIL_TIMEOUT_SEC = 600

export class AnimQueue {
  private readonly slots = new Map<number, Slot>()

  constructor(private readonly stage: AnimStage) {}

  /** Põe na fila do personagem; começa já se ele estiver livre (no próximo tick). */
  enqueue(id: number, anim: Anim): void {
    this.slot(id).queue.push(anim)
  }

  /** Sinal externo: libera o 'until' com este nome (agora ou quando chegar nele). */
  signal(id: number, name: string): void {
    const s = this.slots.get(id)
    if (s) s.signals.add(name)
  }

  /** Nome da animação em curso (testes e diagnóstico). */
  current(id: number): AnimName | null {
    return this.slots.get(id)?.current?.anim.name ?? null
  }

  pending(id: number): number {
    return this.slots.get(id)?.queue.length ?? 0
  }

  /** Interrompe e descarta tudo do personagem (pedido, saída do mapa). */
  cancel(id: number): void {
    const s = this.slots.get(id)
    if (!s) return
    if (s.current) this.release(id)
    this.slots.delete(id)
  }

  tick(dt: number): void {
    for (const [id, s] of [...this.slots]) {
      if (!this.stage.exists(id)) {
        this.slots.delete(id)
        continue
      }
      const waiting = this.stage.waiting(id)
      if (waiting && !(s.current?.anim.keepOnWaiting ?? s.queue[0]?.keepOnWaiting)) {
        // Pedido vence enfeite: para agora e descarta a fila.
        this.cancel(id)
        continue
      }
      this.advance(id, s, dt)
      if (!s.current && s.queue.length === 0) this.slots.delete(id)
    }
  }

  private slot(id: number): Slot {
    let s = this.slots.get(id)
    if (!s) {
      s = { current: null, queue: [], signals: new Set() }
      this.slots.set(id, s)
    }
    return s
  }

  /** Anda os passos que terminam na hora; para no primeiro que precisa de tempo. */
  private advance(id: number, s: Slot, dt: number): void {
    for (let guard = 0; guard < 64; guard++) {
      if (!s.current) {
        const next = s.queue.shift()
        if (!next) return
        s.current = { anim: next, step: 0, started: false, timer: 0, moving: false, stranded: false }
        this.stage.pin(id, true)
      }
      const r = s.current
      const step = r.anim.steps[r.step]
      if (!step) {
        this.release(id)
        s.current = null
        continue
      }
      if (!this.run(id, s, r, step, dt)) return
      r.step++
      r.started = false
      // O tempo deste tique já foi gasto pelo passo que precisava dele.
      dt = 0
    }
  }

  /** Executa um passo; true = terminou (passa ao próximo). */
  private run(id: number, s: Slot, r: Running, step: AnimStep, dt: number): boolean {
    const first = !r.started
    r.started = true
    switch (step.do) {
      case 'prop':
        this.stage.setProp(id, step.prop, step.tint ?? null)
        return true
      case 'caption':
        this.stage.caption(id, step.text, step.sec)
        return true
      case 'call':
        step.fn()
        return true
      case 'walk':
      case 'home': {
        if (first) {
          if (r.stranded) return true
          const ok = step.do === 'home' ? this.stage.home(id) : step.to !== null && this.stage.walk(id, step.to)
          if (!ok) {
            // Sem destino: vira só o balão, sem caminhada e sem travar.
            if (step.do === 'walk') r.stranded = true
            return true
          }
        }
        return !this.stage.walking(id)
      }
      case 'wait':
        if (first) r.timer = step.sec
        r.timer -= dt
        return r.timer <= 0
      case 'until':
        if (first) r.timer = step.timeoutSec ?? UNTIL_TIMEOUT_SEC
        if (s.signals.delete(step.signal)) return true
        r.timer -= dt
        return r.timer <= 0
    }
  }

  /** Fim (ou corte) da animação: solta o adereço e devolve o personagem ao FSM. */
  private release(id: number): void {
    this.stage.setProp(id, null)
    this.stage.pin(id, false)
  }
}
