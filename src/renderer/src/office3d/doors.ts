/**
 * Portas das salas: abrem quando alguém está perto de atravessar e fecham
 * depois. Só as salas à vista giram (sala fora da tela fica parada; ao voltar,
 * a cena põe a porta já no lugar com `doorWant`). Nada aloca por quadro.
 */
import type { Brain } from './brainBody'
import type { RoomView } from './decor'

/** Quanto abre (rad), a que distância de alguém e a que velocidade. */
export const DOOR_OPEN = 1.35
const DOOR_NEAR = 1.3
const DOOR_SPEED = 4

/** Porta que alguém (visível, da sala) está perto de atravessar fica aberta. */
export function doorWant(brains: readonly Brain[], id: string, view: RoomView): number {
  for (let i = 0; i < brains.length; i++) {
    const b = brains[i]
    if (b.visible && b.roomId === id && Math.abs(b.x - view.doorAt.x) < DOOR_NEAR && Math.abs(b.z - view.doorAt.z) < DOOR_NEAR) return DOOR_OPEN
  }
  return 0
}

/**
 * Gira as portas das salas à vista em direção ao que querem; `moved.v` vira
 * true se alguma mexeu (a sombra muda). Devolve o ritmo pedido: 2 se alguma
 * PERTO/MÉDIO mexeu, 1 se só no LONGE, 0 paradas.
 */
export function swingDoors(rooms: ReadonlyArray<{ id: string; view: RoomView }>, brains: readonly Brain[], dt: number, moved: { v: boolean }): 0 | 1 | 2 {
  let rate: 0 | 1 | 2 = 0
  for (let r = 0; r < rooms.length; r++) {
    const { id, view } = rooms[r]
    if (view.lod.culled) continue
    const want = doorWant(brains, id, view)
    const cur = view.door.rotation.y
    if (cur === want) continue
    view.door.rotation.y = cur + Math.max(-DOOR_SPEED * dt, Math.min(DOOR_SPEED * dt, want - cur))
    moved.v = true
    if (view.lod.level < 2) rate = 2
    else if (rate === 0) rate = 1
  }
  return rate
}
