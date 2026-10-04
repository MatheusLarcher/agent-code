/**
 * A coluna "Fez" do app Contexto — PURO (sem React, sem IO).
 *
 *   segmentForTurn(msgs, turnId)  as mensagens de um turno: do pedido do usuário
 *                                 até o próximo. O turno do histórico (turnId =
 *                                 o uuid do envio) é achado pelo `turnIds` que a
 *                                 saída do CLI carrega; a continuação automática
 *                                 (troca de modelo/conta) fica no mesmo trecho,
 *                                 porque não abre pedido novo. Sem turnId: o
 *                                 turno atual. null: o turno não está nas
 *                                 mensagens carregadas.
 *   didOfTurn(msgs, opts)         arquivos alterados com +/− e os modelos de cada
 *                                 um, memórias (enviada / lida / gravada) e as
 *                                 outras ações — tudo do turno, cada item com o
 *                                 modelo do seu tool-use; `models` = os modelos
 *                                 das ações, na ordem.
 */
import { describeTool } from '../../components/toolDescribe'
import type { UIMessage } from '../../types'
import { buildTurnActions, type ActionGroup, type ChangedFile, type MemoryRead, type MemorySave, type ReadItem } from './actionsModel'

export interface DidFile extends ChangedFile {
  added: number
  removed: number
}

export type DidMemory =
  | { tag: 'sent'; relPath: string }
  | ({ tag: 'read' } & MemoryRead)
  | ({ tag: 'saved' } & MemorySave)

export interface TurnDid {
  files: DidFile[]
  memories: DidMemory[]
  reads: ReadItem[]
  other: ActionGroup[]
  models: string[]
}

const hasTurn = (m: UIMessage, turnId: string): boolean => {
  const ids = (m as { turnIds?: unknown }).turnIds
  return Array.isArray(ids) && ids.includes(turnId)
}

export function segmentForTurn(msgs: readonly UIMessage[], turnId: string | null): readonly UIMessage[] | null {
  let at: number
  if (turnId) {
    at = msgs.findIndex((m) => hasTurn(m, turnId))
    if (at < 0) return null
  } else {
    at = msgs.length - 1
    if (at < 0) return []
  }
  let start = at
  while (start > 0 && msgs[start].kind !== 'user') start--
  let end = at + 1
  while (end < msgs.length && msgs[end].kind !== 'user') end++
  return msgs.slice(start, end)
}

export interface DidOptions {
  memoriesDir?: string | null
  memoriesSent?: readonly string[] | null
}

export function didOfTurn(msgs: readonly UIMessage[], opts: DidOptions = {}): TurnDid {
  const acts = buildTurnActions(msgs, opts)
  const byId = new Map<string, UIMessage>()
  for (const m of msgs) if (m.kind === 'tool-use') byId.set(m.id, m)
  const files = acts.changed.map((tab): DidFile => {
    let added = 0
    let removed = 0
    for (const id of new Set(tab.edits.map((e) => e.tool))) {
      const m = byId.get(id)
      if (m?.kind !== 'tool-use') continue
      const stats = describeTool(m.name, m.input).stats
      added += stats?.added ?? 0
      removed += stats?.removed ?? 0
    }
    return { ...tab, added, removed }
  })
  const memories: DidMemory[] = [
    ...acts.memory.sent.map((relPath): DidMemory => ({ tag: 'sent', relPath })),
    ...acts.memory.read.map((r): DidMemory => ({ tag: 'read', ...r })),
    ...acts.memory.saved.map((s): DidMemory => ({ tag: 'saved', ...s }))
  ]
  return { files, memories, reads: acts.read, other: acts.other, models: acts.models }
}
