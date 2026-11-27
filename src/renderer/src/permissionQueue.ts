/**
 * Pedidos de permissão/pergunta pendentes, em FILA por conversa. O agente pode
 * pedir duas coisas seguidas (duas edições em paralelo): com uma vaga só, a
 * segunda sobrescrevia a primeira e, ao responder, a vaga era limpa — o pedido
 * que sobrou sumia da tela sem resposta e a sessão esperava os 7 min do prazo.
 * A tela mostra o primeiro da fila; respondido ou expirado, entra o próximo.
 */
import type { PermissionRequest } from '@shared/ipc'

export type PermissionQueues = Record<string, PermissionRequest[]>

/** Acrescenta no fim (o mesmo id não entra duas vezes). */
export function enqueuePermission(q: PermissionQueues, convId: string, req: PermissionRequest): PermissionQueues {
  const list = q[convId] ?? []
  if (list.some((r) => r.id === req.id)) return q
  return { ...q, [convId]: [...list, req] }
}

/** Tira o pedido `id` (respondido ou expirado); a conversa sai quando a fila esvazia. */
export function dropPermission(q: PermissionQueues, convId: string, id: string): PermissionQueues {
  const list = q[convId]
  if (!list?.some((r) => r.id === id)) return q
  const rest = list.filter((r) => r.id !== id)
  if (rest.length) return { ...q, [convId]: rest }
  const { [convId]: _gone, ...others } = q
  return others
}

/** Esvazia a fila da conversa (fim de turno, sessão encerrada). */
export function clearPermissions(q: PermissionQueues, convId: string): PermissionQueues {
  if (!(convId in q)) return q
  const { [convId]: _gone, ...others } = q
  return others
}

/** Troca o pedido `id` por `update(pedido)` onde ele estiver na fila. */
export function updatePermission(
  q: PermissionQueues,
  convId: string,
  id: string,
  update: (req: PermissionRequest) => PermissionRequest
): PermissionQueues {
  const list = q[convId]
  if (!list?.some((r) => r.id === id)) return q
  return { ...q, [convId]: list.map((r) => (r.id === id ? update(r) : r)) }
}

/** O pedido visível de cada conversa: o primeiro da fila. */
export function currentPermissions(q: PermissionQueues): Record<string, PermissionRequest> {
  const out: Record<string, PermissionRequest> = {}
  for (const [convId, list] of Object.entries(q)) if (list[0]) out[convId] = list[0]
  return out
}
