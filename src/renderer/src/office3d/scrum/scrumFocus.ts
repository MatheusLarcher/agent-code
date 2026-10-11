/**
 * O clique no Scrum Master é um foco próprio (como a estante de Memórias): a
 * câmera fica perto dele, o painel "Diário do Scrum Master" abre à direita e o
 * chat flutuante sai. Qualquer SM (um por sala) abre o mesmo painel, então o
 * foco vira uma chave só — SCRUM_PANEL_KEY — e não troca a conversa ativa.
 */
import type { Office3DEngine } from '../engine'
import { MEMORY_SHELF_KEY } from '../engineTypes'

export const SCRUM_PANEL_KEY = 'scrum-master'

type Engine = Pick<Office3DEngine, 'scene'> | null | undefined

const spotOf = (engine: Engine, key: string | null): string | undefined => (key ? engine?.scene.character(key)?.spot : undefined)

/** A chave do foco na tela: o SM de qualquer sala vira SCRUM_PANEL_KEY. */
export function scrumFocusKey(engine: Engine, key: string | null): string | null {
  return spotOf(engine, key) === 'scrum' ? SCRUM_PANEL_KEY : key
}

/** O foco num posto fixo (a Central no console, o SM no quadro) não troca a conversa do chat. */
export function focusKeepsChat(engine: Engine, key: string): boolean {
  const spot = spotOf(engine, key)
  return spot === 'central' || spot === 'scrum'
}

/** A conversa da mesa focada; o SM não tem mesa (o painel dele é de todos os projetos). */
export function deskConvOf(engine: Engine, key: string | null): string | undefined {
  const c = key ? engine?.scene.character(key) : undefined
  return c && c.spot !== 'scrum' ? c.model.convId : undefined
}

/** O foco abre um painel lateral que toma o lugar do chat flutuante. */
export function panelTakesChat(focusKey: string | null): boolean {
  return focusKey === MEMORY_SHELF_KEY || focusKey === SCRUM_PANEL_KEY
}
