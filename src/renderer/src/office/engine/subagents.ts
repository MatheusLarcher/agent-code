// Derivado de pixel-agents (MIT, (c) 2026 Pablo De Lucca) — ver ../LICENSE-pixel-agents.md

import { createCharacter } from './characters'
import type { CharacterLook } from './types'
import { closestFreeTile, forgetCharacter, roomTiles, type OfficeWorld } from './world'

function key(parentAgentId: number, toolId: string): string {
  return `${parentAgentId}:${toolId}`
}

/**
 * Subagente (Task/Agent tool) nasce no tile livre mais perto do pai, dentro da
 * sala dele, e perambula só ali. Id negativo e estável: chamar de novo com o
 * mesmo pai+tool devolve o mesmo id, e um id nunca é reaproveitado.
 */
export function addSubagent(world: OfficeWorld, parentAgentId: number, toolId: string, look: CharacterLook): number {
  const k = key(parentAgentId, toolId)
  const known = world.subagents.idByKey.get(k)
  if (known !== undefined) return known

  const id = world.subagents.nextId--
  const parent = world.characters.get(parentAgentId)
  const roomId = parent?.roomId ?? null
  const inRoom = roomTiles(world, roomId)
  const tiles = inRoom.length > 0 ? inRoom : world.walkableTiles
  const from = parent ? { col: parent.tileCol, row: parent.tileRow } : (tiles[0] ?? { col: 0, row: 0 })
  const spawn = closestFreeTile(world, tiles, from.col, from.row) ?? from

  const ch = createCharacter(id, look, roomId, spawn, parent?.dir)
  ch.isSubagent = true
  ch.parentAgentId = parentAgentId
  world.characters.set(id, ch)
  world.subagents.idByKey.set(k, id)
  world.subagents.meta.set(id, { parentAgentId, toolId })
  return id
}

/**
 * Some na hora: o subagente não tem assento nem porta própria — nasceu ao lado
 * do pai e termina ali (o original fazia isso com o efeito matrix, que não veio).
 */
export function removeSubagent(world: OfficeWorld, parentAgentId: number, toolId: string): void {
  const k = key(parentAgentId, toolId)
  const id = world.subagents.idByKey.get(k)
  if (id === undefined) return
  world.subagents.idByKey.delete(k)
  world.subagents.meta.delete(id)
  forgetCharacter(world, id)
}

export function removeAllSubagents(world: OfficeWorld, parentAgentId: number): void {
  // Copia antes: removeSubagent mexe no mapa que está sendo percorrido.
  for (const meta of [...world.subagents.meta.values()]) {
    if (meta.parentAgentId === parentAgentId) removeSubagent(world, parentAgentId, meta.toolId)
  }
}

export function getSubagentId(world: OfficeWorld, parentAgentId: number, toolId: string): number | null {
  return world.subagents.idByKey.get(key(parentAgentId, toolId)) ?? null
}
