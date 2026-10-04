/**
 * Quando a mensagem SAI do destino: o "não era aqui" do usuário e o descarte sem
 * rodar (Stop comum, lixeira da fila, conversa apagada). Nos dois, o pedido
 * roteado deste PC volta a perguntar "Para onde vai?" sem o destino de onde saiu
 * — mensagem nenhuma fica "entregue" sem ter rodado. Toda saída avança a geração
 * do pedido: uma entrega antiga que volte de um `await` não mexe mais nele.
 */
import { patchRequest, removeReplyOf, isOwnEntry, isRoutedEntry } from './centralEntries'
import {
  DISCARDED_MESSAGE,
  centralEntries,
  findRequest,
  nextGeneration,
  ownedHere,
  patchCentral,
  rescueEntry,
  routeEntry,
  type CentralFlowDeps
} from './centralDelivery'
import type { CentralRequestEntry, CentralState } from '@shared/central'

/**
 * "Não era aqui" (só pedidos roteados e entregues): tira a mensagem do destino
 * — da fila, se ainda espera (só aquele item); parando o turno, se é ele que
 * roda ou se a recuperação automática ainda vai retomá-lo (o resto da fila
 * fica); nada, se já terminou —, apaga a resposta espelhada e pergunta para onde
 * vai (`forceAsk`, sem o destino errado).
 */
export async function moveEntry(d: CentralFlowDeps, entryId: string): Promise<void> {
  const entry = findRequest(d, entryId)
  if (!entry || !ownedHere(d, entry)) return
  if (entry.state !== 'delivered' || !entry.anchor || !entry.route || entry.injected || !isRoutedEntry(entry)) return
  const gen = nextGeneration(d, entryId)
  const { convId, msgId } = entry.anchor
  const queued = d.queueRef.current.find((q) => q.convId === convId && q.msgId === msgId)
  const running =
    d.inflightRef.current[convId]?.msgId === msgId ||
    d.convsRef.current.find((c) => c.id === convId)?.recovery?.messageId === msgId
  if (queued) d.deleteQueued(queued.id)
  else if (d.busyRef.current.has(convId) && running) d.stopKeepingQueue(convId)
  const from = entry.route.target
  d.moved.set(entryId, { rule: entry.route.rule, confidence: entry.route.confidence })
  patchCentral(d, (s) =>
    patchRequest(removeReplyOf(s, entryId), entryId, (e) => {
      const { route: _route, anchor: _anchor, ask: _ask, ...rest } = e
      return { ...rest, state: 'routing', movedFrom: from }
    })
  )
  const text = d.payloads.get(entryId)?.text ?? entry.text
  await routeEntry(d, { entryId, text, attachments: entry.attachments ?? [], forceAsk: true, exclude: from, reason: 'moved', gen })
}

/**
 * Mensagens que saíram da fila (ou da conversa apagada) sem rodar. Só age nos
 * pedidos deste PC ancorados nelas e ainda "entregues": o roteado volta a
 * perguntar (motivo `target-missing`, sem o destino); o adotado vira falha —
 * foi enviado na própria conversa, não há para onde reenviar.
 */
export async function discardEntries(d: CentralFlowDeps, convId: string, msgIds: readonly string[]): Promise<void> {
  const ids = new Set(msgIds)
  const hits = centralEntries(d).filter(
    (e): e is CentralRequestEntry =>
      e.kind === 'request' &&
      e.state === 'delivered' &&
      !e.injected &&
      e.anchor?.convId === convId &&
      ids.has(e.anchor.msgId) &&
      isOwnEntry(e, d.device)
  )
  if (!hits.length) return
  const routed = hits.filter(isRoutedEntry)
  const gens = new Map(hits.map((e) => [e.id, nextGeneration(d, e.id)]))
  patchCentral(d, (s) =>
    hits.reduce<CentralState>(
      (acc, hit) =>
        patchRequest(removeReplyOf(acc, hit.id), hit.id, (e) => {
          const { anchor: _anchor, ask: _ask, ...kept } = e
          if (!isRoutedEntry(e)) return { ...kept, state: 'failed' }
          const { route: _route, ...rest } = kept
          return { ...rest, state: 'routing' }
        }),
      s ?? { entries: [] }
    )
  )
  if (!routed.length) return
  d.notify('aviso', DISCARDED_MESSAGE)
  for (const e of routed) {
    const text = d.payloads.get(e.id)?.text ?? e.text
    await routeEntry(d, {
      entryId: e.id,
      text,
      attachments: e.attachments ?? [],
      forceAsk: true,
      ...(e.route ? { exclude: e.route.target } : {}),
      reason: 'target-missing',
      gen: gens.get(e.id)
    }).catch((err: unknown) => rescueEntry(d, e.id, err))
  }
}
