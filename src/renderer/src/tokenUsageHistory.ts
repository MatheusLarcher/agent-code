import type { ChatEvent, LlmCall as PersistedLlmCall, LlmUsageTotal, TokenUsage, TokenUsageHistory } from '@shared/ipc'
import { emptyUsageMap, reduceUsage, type LlmCall, type UsageMap, type UsageNode } from './tokenUsageTree'

/**
 * O consumo de tokens de uma conversa — PURO. Junta o que o banco guardou
 * (`getTokenUsageHistory`: as chamadas e os totais agregados) com o que chegou ao
 * vivo (`UsageMap`) sem contar duas vezes, e o corta nas fatias que a barrinha do
 * chat flutuante do Escritório (UsageMiniBar) e o painel por agente mostram.
 */

/** Converte uma chamada persistida (camelCase, ver `LlmCall` em shared/ipc.ts)
 *  no evento `llm-call` que `reduceUsage` sabe processar — mesma forma que o
 *  main já emite ao vivo, só que reidratada do banco. */
export function persistedCallToEvent(call: PersistedLlmCall): ChatEvent {
  return {
    kind: 'llm-call',
    node_id: call.nodeId,
    parent_node_id: call.parentNodeId,
    seq: call.seq,
    model: call.model,
    tokens: {
      input: call.inputTokens,
      output: call.outputTokens,
      cacheRead: call.cacheReadTokens,
      cacheWrite: call.cacheWriteTokens
    },
    inputPreview: call.inputPreview ?? '',
    outputPreview: call.outputPreview ?? '',
    subagentType: call.subagentType ?? undefined,
    taskDescription: call.taskDescription ?? undefined,
    createdAt: new Date(call.createdAt).getTime()
  }
}

export function buildHistoryMap(calls: PersistedLlmCall[]): UsageMap {
  return calls.reduce((map, call) => reduceUsage(map, persistedCallToEvent(call)), emptyUsageMap)
}

/** Funde o histórico reidratado do banco com o que chegou ao vivo nesta
 *  sessão, sem duplicar: quando os dois lados conhecem a mesma chamada
 *  (mesmo node + seq), a versão ao vivo vence — é a mais recente. */
export function mergeUsageMaps(history: UsageMap, live: UsageMap): UsageMap {
  const nodeIds = new Set([...Object.keys(history.nodes), ...Object.keys(live.nodes)])
  const nodes: Record<string, UsageNode> = {}
  for (const id of nodeIds) {
    const a = history.nodes[id]
    const b = live.nodes[id]
    if (a && !b) {
      nodes[id] = a
      continue
    }
    if (b && !a) {
      nodes[id] = b
      continue
    }
    if (a && b) {
      const bySeq = new Map<number, LlmCall>()
      for (const call of a.calls) bySeq.set(call.seq, call)
      for (const call of b.calls) bySeq.set(call.seq, call)
      nodes[id] = {
        nodeId: id,
        parentNodeId: b.parentNodeId ?? a.parentNodeId,
        subagentType: a.subagentType ?? b.subagentType,
        taskDescription: a.taskDescription ?? b.taskDescription,
        calls: [...bySeq.values()].sort((x, y) => x.seq - y.seq),
        children: []
      }
    }
  }
  const rootIds = Object.keys(nodes).filter((id) => {
    const parentId = nodes[id].parentNodeId
    return parentId == null || !nodes[parentId]
  })
  return { nodes, rootIds }
}

const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function add(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite }
}

export function sumTotals(totals: LlmUsageTotal[]): TokenUsage {
  return totals.reduce(
    (acc, t) => add(acc, { input: t.sumInput, output: t.sumOutput, cacheRead: t.sumCacheRead, cacheWrite: t.sumCacheWrite }),
    ZERO
  )
}

export interface UsageTotals {
  tokens: TokenUsage
  /** Chamadas ao modelo. */
  calls: number
}

/** Soma as chamadas de um mapa, menos as `skip` (chave `nodeId#seq`). */
function mapTotals(map: UsageMap, skip?: ReadonlySet<string>): UsageTotals {
  let tokens = ZERO
  let calls = 0
  for (const node of Object.values(map.nodes)) {
    for (const call of node.calls) {
      if (skip?.has(`${node.nodeId}#${call.seq}`)) continue
      tokens = add(tokens, call.tokens)
      calls++
    }
  }
  return { tokens, calls }
}

/**
 * O consumo da conversa inteira. Com totais no banco (eles guardam também as
 * chamadas que a poda de 15 dias já apagou), vale o total do banco MAIS as
 * chamadas ao vivo que o banco ainda não conhecia (as depois da leitura) —
 * conhecida = o mesmo node + seq. Sem totais, vale a soma das chamadas
 * (histórico e ao vivo juntos, a versão ao vivo vencendo).
 */
export function usageTotals(history: TokenUsageHistory, live: UsageMap): UsageTotals {
  if (history.totals.length === 0) return mapTotals(mergeUsageMaps(buildHistoryMap(history.calls), live))
  const known = new Set(history.calls.map((c) => `${c.nodeId}#${c.seq}`))
  const extra = mapTotals(live, known)
  return {
    tokens: add(sumTotals(history.totals), extra.tokens),
    calls: history.totals.reduce((n, t) => n + t.callCount, 0) + extra.calls
  }
}

export type UsageSliceKey = keyof TokenUsage

export interface UsageSliceInfo {
  key: UsageSliceKey
  label: string
  /** O que é, em uma frase (o cartão da barrinha). */
  what: string
}

/** Os tipos de consumo, na ordem da barrinha e do cartão. */
export const USAGE_SLICES: readonly UsageSliceInfo[] = [
  { key: 'input', label: 'Entrada', what: 'tokens novos que o modelo leu, sem cache' },
  { key: 'cacheRead', label: 'Cache lido', what: 'reaproveitados do cache, bem mais baratos' },
  { key: 'cacheWrite', label: 'Cache escrito', what: 'gravados no cache para as próximas chamadas' },
  { key: 'output', label: 'Saída', what: 'o que o modelo escreveu de volta' }
]

export interface UsageSlice extends UsageSliceInfo {
  tokens: number
  /** 0–1 do total (0 sem consumo). */
  share: number
}

export function usageSlices(t: TokenUsage): UsageSlice[] {
  const total = t.input + t.output + t.cacheRead + t.cacheWrite
  return USAGE_SLICES.map((s) => ({ ...s, tokens: t[s.key], share: total > 0 ? t[s.key] / total : 0 }))
}

export const tokenCount = (t: TokenUsage): number => t.input + t.output + t.cacheRead + t.cacheWrite

export const fmtTokens = (n: number): string => n.toLocaleString('pt-BR')

/** "88,2%"; fatia que existe mas não chega a 0,1% vira "< 0,1%". */
export function fmtShare(share: number): string {
  if (!(share > 0)) return '0%'
  if (share < 0.001) return '< 0,1%'
  return `${(share * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
}

/** O custo em dólar (o que o SDK informa): "~US$ 0,42"; abaixo de 1 centavo, "< US$ 0,01". */
export function fmtCost(usd: number): string {
  if (!(usd > 0)) return 'US$ 0,00'
  if (usd < 0.01) return '< US$ 0,01'
  return `~US$ ${usd.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
