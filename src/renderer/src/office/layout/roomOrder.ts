/**
 * Ordem das salas no prédio. Regra: a sala não muda de lugar enquanto existe;
 * sala nova entra no fim. Por isso quem sai deixa a vaga VAZIA ('') em vez de
 * puxar as da direita — senão fechar um projeto faria todos os personagens das
 * salas seguintes "teleportarem". Vaga vazia não é reaproveitada por sala nova
 * (ela iria parar no meio, contra a regra); só some quando fica no fim da fila.
 */

export const EMPTY_SLOT = ''

export function stableRoomOrder(prev: readonly string[], current: readonly string[]): string[] {
  const alive = new Set(current)
  const out = prev.map((id) => (id !== EMPTY_SLOT && alive.has(id) ? id : EMPTY_SLOT))
  const placed = new Set(out)
  for (const id of current) {
    if (id === EMPTY_SLOT || placed.has(id)) continue
    out.push(id)
    placed.add(id)
  }
  // Vagas no fim não seguram ninguém no lugar: podem sumir.
  while (out.length > 0 && out[out.length - 1] === EMPTY_SLOT) out.pop()
  return out
}
