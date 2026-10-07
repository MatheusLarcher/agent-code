/**
 * Os modos "de lugar" do cérebro (brain.ts) — PUROS: o fixo no lugar dele (PO,
 * memorista, Central no console, Agent Manager à cabeceira), a estante de
 * Memórias (`archive`) e a sala de reunião (`meeting`). Só escolhem o gesto e
 * para onde olhar; o movimento é de brainBody.ts.
 */
import { lookAt, setAction, type Brain } from './brainBody'
import { TV_CENTER } from './meetingRoom'
import type { Action } from './poses'

export function runFixed(b: Brain): void {
  b.look = 'none'
  const working = b.phase === 'working'
  if (b.style === 'manager') {
    // Explica o plano para a TV enquanto trabalha (mão no queixo e apontando); parado, sentado olhando para ela.
    setAction(b, !b.arrived ? 'none' : working ? (Math.floor(b.modeT / 4) % 2 ? 'web' : 'assist') : 'sitIdle')
    if (b.arrived) lookAt(b, TV_CENTER.x, TV_CENTER.y, TV_CENTER.z)
    return
  }
  if (working && b.style === 'board') setAction(b, 'readBoard')
  else if (working && b.style === 'archive') setAction(b, 'readBook')
  else if (b.style === 'console') setAction(b, b.arrived ? consoleAction(b.modeT + b.seed * 37, working) : 'none')
  else setAction(b, b.arrived ? 'idle' : 'none')
  b.prop = working && b.style === 'archive' ? 'book' : null
}

/**
 * A Central no console nunca fica parada (cada ação tem movimento do Mixamo): trabalhando, digita
 * no teclado do console e fala no fone encaminhando os pedidos, aponta e escuta; sem trabalho, os
 * ociosos em pé, olhando a praça, conversando no fone e se alongando. [ação, segundos], em ciclo.
 */
const CONSOLE_WORK: ReadonlyArray<readonly [Action, number]> = [['type', 7], ['talk', 5], ['type', 6], ['point', 2.5], ['listen', 3.5]]
const CONSOLE_IDLE: ReadonlyArray<readonly [Action, number]> = [['idle', 12], ['talk', 5], ['idle', 9], ['lookOut', 4], ['idle', 8], ['stretchUp', 3]]

/** A ação do console no instante `t` (s, já com a fase da seed). */
export function consoleAction(t: number, working: boolean): Action {
  const list = working ? CONSOLE_WORK : CONSOLE_IDLE
  let total = 0
  for (const [, d] of list) total += d
  let u = ((t % total) + total) % total
  for (const [a, d] of list) {
    if (u < d) return a
    u -= d
  }
  return list[0][0]
}

/** Chamando sem resposta por tanto tempo (s), quem está ao lado da TV passa a pular. */
export const CALL_JUMP_S = 60
/** Depois disso, o ciclo: metade pulando, metade acenando. */
const CALL_CYCLE_S = 6
/** Na fila do chamado, sentado: acena SEAT_WAVE_S a cada SEAT_WAVE_EVERY_S. */
const SEAT_WAVE_EVERY_S = 9
const SEAT_WAVE_S = 2

/** Na estante: puxa o fichário, folheia; gravando, põe a folha no fichário de vez em quando. */
export function runArchive(b: Brain, dt: number): void {
  if (!b.arrived) {
    setAction(b, 'none')
    return
  }
  b.leisureT += dt
  const t = b.leisureT
  const write = b.shelfTrip?.use === 'write'
  setAction(b, t < 1 ? 'grabBook' : write && t % 6 > 3.5 ? 'stick' : 'readBook')
  b.prop = t > 0.5 ? (write && t % 6 > 3.5 ? 'note' : 'book') : null
  if (b.poi) lookAt(b, b.poi.look.x, b.poi.look.y, b.poi.look.z)
}

export function runMeeting(b: Brain): void {
  const v = b.venue
  if (!b.arrived || !v) {
    setAction(b, 'none')
    b.look = 'none'
    return
  }
  if (v.call && v.role === 'present') {
    // Chamou o usuário: de pé ao lado da TV, acenando para a câmera; sem resposta, pula também.
    const late = b.modeT - CALL_JUMP_S
    setAction(b, late >= 0 && late % CALL_CYCLE_S < CALL_CYCLE_S / 2 ? 'jump' : 'wave')
    b.faceCamera = true
    b.look = 'camera'
    return
  }
  // Na fila do chamado: sentado, olhando para a câmera e acenando de vez em quando.
  setAction(b, (b.modeT + b.seed * SEAT_WAVE_EVERY_S) % SEAT_WAVE_EVERY_S < SEAT_WAVE_S ? 'wave' : 'sitIdle')
  b.look = 'camera'
}
