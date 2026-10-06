import { describe, expect, it } from 'vitest'
import type { LlmCall, LlmUsageTotal, TokenUsageHistory } from '@shared/ipc'
import { emptyUsageMap, reduceUsage, type UsageMap } from './tokenUsageTree'
import { fmtCost, fmtShare, tokenCount, usageSlices, usageTotals } from './tokenUsageHistory'

function persisted(over: Partial<LlmCall>): LlmCall {
  return {
    id: 'x', convId: 'c1', turnId: 't1', nodeId: 'n1', parentNodeId: null, subagentType: null, taskDescription: null, seq: 0, model: 'claude-sonnet-5-5',
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, costUsd: null, inputPreview: null, outputPreview: null,
    createdAt: new Date(1_700_000_000_000).toISOString(), ...over
  }
}

function total(over: Partial<LlmUsageTotal>): LlmUsageTotal {
  return { convId: 'c1', day: '2026-10-05', model: 'claude-sonnet-5-5', subagentType: null, sumInput: 0, sumOutput: 0, sumCacheRead: 0, sumCacheWrite: 0, sumCost: null, callCount: 0, ...over }
}

/** Uma chamada ao vivo (o evento `llm-call` do main). */
function live(map: UsageMap, node: string, seq: number, tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }): UsageMap {
  return reduceUsage(map, { kind: 'llm-call', node_id: node, parent_node_id: null, seq, model: 'claude-sonnet-5-5', tokens, inputPreview: '', outputPreview: '', createdAt: 1 } as never)
}

const none: TokenUsageHistory = { calls: [], totals: [] }

describe('usageTotals: o consumo da conversa, histórico do banco + ao vivo sem contar duas vezes', () => {
  it('sem nada: zero', () => {
    expect(usageTotals(none, emptyUsageMap)).toEqual({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, calls: 0 })
  })

  it('sem totais no banco: a soma das chamadas; a mesma chamada (node + seq) vale uma vez, a versão ao vivo vencendo', () => {
    let map = live(emptyUsageMap, 'n1', 0, { input: 200, output: 80, cacheRead: 10, cacheWrite: 5 })
    map = live(map, 'n2', 0, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })
    const t = usageTotals({ calls: [persisted({ nodeId: 'n1', seq: 0 }), persisted({ nodeId: 'n1', seq: 1, inputTokens: 7, outputTokens: 7, cacheReadTokens: 7, cacheWriteTokens: 7 })], totals: [] }, map)
    // n1#0 ao vivo (200/80/10/5), n1#1 do banco (7×4), n2#0 ao vivo (1/2/3/4).
    expect(t).toEqual({ tokens: { input: 208, output: 89, cacheRead: 20, cacheWrite: 16 }, calls: 3 })
  })

  it('com totais no banco (eles guardam também o que a poda apagou): o total do banco MAIS as chamadas ao vivo que ele não conhecia; as conhecidas não somam de novo', () => {
    const history: TokenUsageHistory = {
      calls: [persisted({ nodeId: 'n1', seq: 0 })],
      totals: [total({ sumInput: 1000, sumOutput: 500, sumCacheRead: 90, sumCacheWrite: 40, callCount: 12 }), total({ day: '2026-10-04', sumInput: 10, sumOutput: 5, callCount: 2 })]
    }
    let map = live(emptyUsageMap, 'n1', 0, { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }) // o banco já conhece
    map = live(map, 'n9', 3, { input: 20, output: 10, cacheRead: 0, cacheWrite: 1 }) // chegou depois da leitura
    expect(usageTotals(history, map)).toEqual({ tokens: { input: 1030, output: 515, cacheRead: 90, cacheWrite: 41 }, calls: 15 })
    // Sem nada ao vivo: só o banco.
    expect(usageTotals(history, emptyUsageMap)).toEqual({ tokens: { input: 1010, output: 505, cacheRead: 90, cacheWrite: 40 }, calls: 14 })
  })
})

describe('usageSlices e a formatação', () => {
  it('uma fatia por tipo, na ordem da barra, com a parte do total; sem consumo, tudo zero', () => {
    const s = usageSlices({ input: 25, output: 25, cacheRead: 50, cacheWrite: 0 })
    expect(s.map((x) => [x.key, x.tokens, x.share])).toEqual([['input', 25, 0.25], ['cacheRead', 50, 0.5], ['cacheWrite', 0, 0], ['output', 25, 0.25]])
    expect(s.map((x) => x.label)).toEqual(['Entrada', 'Cache lido', 'Cache escrito', 'Saída'])
    expect(s.every((x) => x.what.length > 10)).toBe(true)
    expect(usageSlices({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }).every((x) => x.share === 0)).toBe(true)
    expect(tokenCount({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })).toBe(10)
  })

  it('a parte em pt-BR (a fatia minúscula não vira "0%") e o custo em dólar (centavo é o piso)', () => {
    expect([fmtShare(0), fmtShare(0.8961), fmtShare(0.06), fmtShare(0.0004), fmtShare(1)]).toEqual(['0%', '89,6%', '6%', '< 0,1%', '100%'])
    expect([fmtCost(0), fmtCost(0.004), fmtCost(0.4234), fmtCost(12.5), fmtCost(1234.5)]).toEqual(['US$ 0,00', '< US$ 0,01', '~US$ 0,42', '~US$ 12,50', '~US$ 1.234,50'])
  })
})
