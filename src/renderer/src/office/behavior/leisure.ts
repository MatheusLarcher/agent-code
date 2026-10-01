/**
 * Lazer do agente parado (card dec-conversas-abertas-lazer).
 *
 * Sem turno e sem pedido, o personagem alterna entre 'celular', 'perambular'
 * e 'mesa', num sorteio que troca a cada 2 a 5 min de jogo. Com idleSince ≥
 * 10 min ele vai ao assento, senta e dorme com 'zzz'. wake(ch) interrompe
 * tudo na hora e devolve o personagem ao FSM normal do motor.
 *
 * Custo por quadro: O(personagens). findPath (via sendToSeat) só roda quando o
 * comportamento troca, nunca a cada tique.
 */

import { CharacterState } from '../engine/types'
import type { Character } from '../engine/types'
import type { IdleBehavior, OfficeState } from '../engine/officeState'

export type LeisureMode = 'celular' | 'perambular' | 'mesa' | 'dormir'

/** Segundos parado antes de dormir. */
export const SLEEP_AFTER_SEC = 10 * 60
export const SWITCH_MIN_SEC = 2 * 60
export const SWITCH_MAX_SEC = 5 * 60

const ROTATION: readonly LeisureMode[] = ['celular', 'perambular', 'mesa']

interface LeisureEntry {
  mode: LeisureMode
  /** api.time em que o sorteio troca de novo. */
  until: number
  /** Já mandou ao assento neste comportamento (evita findPath repetido). */
  sentToSeat: boolean
}

export interface LeisureOptions {
  /** Gerador em [0,1); injetável para os testes. Padrão: Math.random. */
  rng?: () => number
}

export interface Leisure {
  /** O gancho para OfficeState.idleBehavior. */
  idleBehavior: IdleBehavior
  /** Acorda: limpa o prop, zera idleSince e devolve ao FSM do motor. */
  wake(ch: Character): void
  /** Comportamento atual (para o painel e os testes); null = fora do lazer. */
  modeOf(id: number): LeisureMode | null
  /** Esquece o estado de um personagem que saiu do mapa. */
  forget(id: number): void
}

/** Personagem que nunca fica em lazer: trabalhando, saindo ou esperando o usuário. */
function blocksLeisure(ch: Character): boolean {
  return ch.isActive || ch.leaving || ch.bubble === 'permissao' || ch.bubble === 'pergunta'
}

function atOwnSeat(ch: Character, api: OfficeState): boolean {
  const seat = ch.seatId ? api.seats.get(ch.seatId) : undefined
  return !!seat && ch.tileCol === seat.col && ch.tileRow === seat.row
}

export function createLeisure(opts: LeisureOptions = {}): Leisure {
  const rng = opts.rng ?? Math.random
  const entries = new Map<number, LeisureEntry>()

  function clearOwnProp(ch: Character): void {
    if (ch.prop === 'celular' || ch.prop === 'zzz') ch.prop = null
  }

  function draw(now: number): LeisureEntry {
    const mode = ROTATION[Math.min(ROTATION.length - 1, Math.floor(rng() * ROTATION.length))]
    const until = now + SWITCH_MIN_SEC + rng() * (SWITCH_MAX_SEC - SWITCH_MIN_SEC)
    return { mode, until, sentToSeat: false }
  }

  /** Leva ao assento uma única vez por comportamento (um findPath na troca). */
  function goSit(ch: Character, e: LeisureEntry, api: OfficeState): void {
    if (e.sentToSeat || !ch.seatId) return
    e.sentToSeat = true
    if (ch.state === CharacterState.TYPE && atOwnSeat(ch, api)) return
    api.sendToSeat(ch.id)
  }

  const idleBehavior: IdleBehavior = (ch, _dt, api) => {
    if (blocksLeisure(ch)) {
      if (entries.delete(ch.id)) clearOwnProp(ch)
      return false
    }
    // Subagente não faz lazer: segue a trilha do motor até sair.
    if (ch.isSubagent) return false

    let e = entries.get(ch.id)
    if (ch.idleSince >= SLEEP_AFTER_SEC) {
      if (!e || e.mode !== 'dormir') {
        e = { mode: 'dormir', until: Infinity, sentToSeat: false }
        entries.set(ch.id, e)
        clearOwnProp(ch)
      }
      goSit(ch, e, api)
      // Sentado (ou sem assento): cochila onde está.
      if (ch.state !== CharacterState.WALK) ch.prop = 'zzz'
      return true
    }

    if (!e || api.time >= e.until) {
      e = draw(api.time)
      entries.set(ch.id, e)
      clearOwnProp(ch)
    }

    switch (e.mode) {
      case 'celular':
        // Sentado ou em pé, onde estiver.
        ch.prop = 'celular'
        return true
      case 'mesa':
        if (!ch.seatId) return false
        goSit(ch, e, api)
        return true
      default:
        // 'perambular': o wander do motor, já restrito à sala.
        return false
    }
  }

  function wake(ch: Character): void {
    entries.delete(ch.id)
    clearOwnProp(ch)
    ch.idleSince = 0
    // Sentado descansando: levanta já em vez de esperar o descanso longo.
    if (!ch.isActive && ch.state === CharacterState.TYPE) ch.seatTimer = 0
  }

  return {
    idleBehavior,
    wake,
    modeOf: (id) => entries.get(id)?.mode ?? null,
    forget: (id) => void entries.delete(id)
  }
}

/** Monta o lazer e pluga no gancho do escritório. */
export function installLeisure(state: OfficeState, opts?: LeisureOptions): Leisure {
  const leisure = createLeisure(opts)
  state.idleBehavior = leisure.idleBehavior
  return leisure
}
