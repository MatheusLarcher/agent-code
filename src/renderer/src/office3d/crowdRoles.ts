/**
 * Peças puras da turma (crowd.ts): o que o motor manda a cada feed, a fase de
 * um personagem só pelo modelo, o papel do cérebro de cada personagem do layout
 * e a semente estável por chave.
 */
import type { CrewRole } from '../crew'
import type { OfficeCharacterModel } from '../office/adapter/model'
import type { Role } from './brain'
import type { AgentEvent, AgentPhase, OfficeSnapshot } from './events'
import type { CharacterLayout } from './layout'

/** No modo demonstração o cochilo chega DEMO_TIME_FACTOR vezes mais cedo. */
export const DEMO_TIME_FACTOR = 20

/** O que o motor manda a cada feed: o retrato, os eventos e os relógios. */
export interface LifeInput {
  snapshot: OfficeSnapshot
  events: readonly AgentEvent[]
  /** Epoch ms do retrato (o `now` de snapshotOf/diffEvents). */
  wallNow: number
  /** Relógio do motor (s) no mesmo instante. */
  t: number
}

const SEATED_VISITORS: ReadonlySet<CrewRole> = new Set<CrewRole>(['executor', 'critico', 'navegador-de-codigo'])

/** Fase só pelo modelo (sem retrato de events.ts — testes e o 1º quadro). */
export function modelPhase(m: OfficeCharacterModel): AgentPhase {
  if (m.bubble === 'permissao' || m.bubble === 'pergunta') return 'waiting-permission'
  if (m.bubble === 'erro') return 'error'
  return m.active ? 'working' : 'idle'
}

/** Principal tem mesa; especialistas e subagentes são visitantes; destinos (PO, Memória, Central) e vigia, fixos. */
export function roleOf(c: CharacterLayout): Role {
  const m = c.model
  if (m.placement.kind === 'destination' || m.role === 'vigia') return 'fixed'
  if (m.role === 'principal') return 'desk'
  return SEATED_VISITORS.has(m.role) || m.role === 'subagente' ? 'visitor' : 'fixed'
}

export function seedOf(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193)
  return ((h >>> 0) % 6283) / 1000
}
