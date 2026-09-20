import { useEffect, useMemo, useState } from 'react'
import type { ChatEvent, LlmCall as PersistedLlmCall, LlmUsageTotal, TokenUsage } from '@shared/ipc'
import {
  buildUsageTree,
  emptyUsageMap,
  reduceUsage,
  totalTokens,
  type LlmCall,
  type UsageMap,
  type UsageNode
} from '../tokenUsageTree'
import { IconChevronDown, IconChevronRight } from './Icons'

interface Props {
  /** Conversa aberta no momento, ou `null` sem conversa selecionada. */
  convId: string | null
  /** Acumulador ao vivo desta conversa, alimentado pelos eventos `llm-call`
   *  que chegam enquanto o app está aberto (ver App.tsx). */
  liveMap: UsageMap
}

const emptyTotals: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Converte uma chamada persistida (camelCase, ver `LlmCall` em shared/ipc.ts)
 *  no evento `llm-call` que `reduceUsage` sabe processar — mesma forma que o
 *  main já emite ao vivo, só que reidratada do banco. */
function persistedCallToEvent(call: PersistedLlmCall): ChatEvent {
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

function buildHistoryMap(calls: PersistedLlmCall[]): UsageMap {
  return calls.reduce((map, call) => reduceUsage(map, persistedCallToEvent(call)), emptyUsageMap)
}

/** Funde o histórico reidratado do banco com o que chegou ao vivo nesta
 *  sessão, sem duplicar: quando os dois lados conhecem a mesma chamada
 *  (mesmo node + seq), a versão ao vivo vence — é a mais recente. */
function mergeUsageMaps(history: UsageMap, live: UsageMap): UsageMap {
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

function sumTotals(totals: LlmUsageTotal[]): TokenUsage {
  return totals.reduce(
    (acc, t) => ({
      input: acc.input + t.sumInput,
      output: acc.output + t.sumOutput,
      cacheRead: acc.cacheRead + t.sumCacheRead,
      cacheWrite: acc.cacheWrite + t.sumCacheWrite
    }),
    { ...emptyTotals }
  )
}

function fmt(n: number): string {
  return n.toLocaleString('pt-BR')
}

function nodeLabel(node: UsageNode): string {
  return node.subagentType ?? (node.parentNodeId ? 'subagente' : 'principal')
}

function nodeModels(node: UsageNode): string {
  return [...new Set(node.calls.map((c) => c.model))].join(', ') || '—'
}

function TokenBadges({ t }: { t: TokenUsage }): JSX.Element {
  return (
    <span className="token-badges">
      <span title="Entrada">↓{fmt(t.input)}</span>
      <span title="Saída">↑{fmt(t.output)}</span>
      {(t.cacheRead > 0 || t.cacheWrite > 0) && (
        <span title="Cache (leitura/escrita)">
          ⚡{fmt(t.cacheRead)}/{fmt(t.cacheWrite)}
        </span>
      )}
    </span>
  )
}

function UsageTreeNode({
  node,
  depth,
  expanded,
  onToggle,
  selectedNodeId,
  onSelect
}: {
  node: UsageNode
  depth: number
  expanded: Set<string>
  onToggle: (id: string) => void
  selectedNodeId: string | null
  onSelect: (id: string) => void
}): JSX.Element {
  const isOpen = expanded.has(node.nodeId)
  const totals = totalTokens(node)
  return (
    <div className="token-tree-node" style={{ paddingLeft: depth * 14 }}>
      <div className={`token-tree-row${selectedNodeId === node.nodeId ? ' selected' : ''}`}>
        {node.children.length > 0 ? (
          <button
            type="button"
            className="token-tree-toggle"
            onClick={() => onToggle(node.nodeId)}
            aria-label={isOpen ? 'Recolher' : 'Expandir'}
          >
            {isOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          </button>
        ) : (
          <span className="token-tree-toggle-spacer" />
        )}
        <button type="button" className="token-tree-label" onClick={() => onSelect(node.nodeId)}>
          <strong>{nodeLabel(node)}</strong>
          {node.taskDescription && <span className="token-tree-task"> — {node.taskDescription}</span>}
          <span className="token-tree-model"> ({nodeModels(node)})</span>
        </button>
        <TokenBadges t={totals} />
      </div>
      {isOpen &&
        node.children.map((child) => (
          <UsageTreeNode
            key={child.nodeId}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            selectedNodeId={selectedNodeId}
            onSelect={onSelect}
          />
        ))}
    </div>
  )
}

function findNode(nodes: UsageNode[], id: string): UsageNode | null {
  for (const n of nodes) {
    if (n.nodeId === id) return n
    const hit = findNode(n.children, id)
    if (hit) return hit
  }
  return null
}

function allNodeIds(nodes: UsageNode[]): string[] {
  return nodes.flatMap((n) => [n.nodeId, ...allNodeIds(n.children)])
}

export function TokenUsagePanel({ convId, liveMap }: Props): JSX.Element {
  const [history, setHistory] = useState<{ calls: PersistedLlmCall[]; totals: LlmUsageTotal[] }>({
    calls: [],
    totals: []
  })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)

  useEffect(() => {
    setSelectedNodeId(null)
    setSelectedSeq(null)
    if (!convId) {
      setHistory({ calls: [], totals: [] })
      return
    }
    let cancelled = false
    void window.api.getTokenUsageHistory(convId).then((h) => {
      if (!cancelled) setHistory(h)
    })
    return () => {
      cancelled = true
    }
  }, [convId])

  const historyMap = useMemo(() => buildHistoryMap(history.calls), [history.calls])
  const mergedMap = useMemo(() => mergeUsageMaps(historyMap, liveMap), [historyMap, liveMap])
  const tree = useMemo(() => buildUsageTree(mergedMap), [mergedMap])

  // Roots começam expandidos — o resto, sob demanda.
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const root of tree) next.add(root.nodeId)
      return next
    })
  }, [tree])

  const grandTotal = useMemo(() => {
    if (history.totals.length > 0) return sumTotals(history.totals)
    if (tree.length > 0) {
      return tree.reduce(
        (acc, root) => {
          const t = totalTokens(root)
          return {
            input: acc.input + t.input,
            output: acc.output + t.output,
            cacheRead: acc.cacheRead + t.cacheRead,
            cacheWrite: acc.cacheWrite + t.cacheWrite
          }
        },
        { ...emptyTotals }
      )
    }
    return emptyTotals
  }, [history.totals, tree])

  const totalCalls = useMemo(() => Object.values(mergedMap.nodes).reduce((n, node) => n + node.calls.length, 0), [
    mergedMap
  ])

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const select = (id: string): void => {
    setSelectedNodeId(id)
    setSelectedSeq(null)
  }

  const selectedNode = selectedNodeId ? findNode(tree, selectedNodeId) : null
  const selectedCall = selectedNode?.calls.find((c) => c.seq === selectedSeq) ?? null

  if (!convId) {
    return <div className="token-usage-panel token-usage-empty">Nenhuma conversa selecionada.</div>
  }

  return (
    <div className="token-usage-panel">
      <div className="token-usage-header">
        <div className="token-usage-header-title">Consumo de tokens</div>
        <TokenBadges t={grandTotal} />
        <span className="token-usage-call-count">{totalCalls} chamada{totalCalls === 1 ? '' : 's'}</span>
      </div>

      {tree.length === 0 ? (
        <div className="token-usage-empty">Nenhuma chamada ao modelo ainda.</div>
      ) : (
        <div className="token-usage-body">
          <div className="token-tree">
            {tree.map((root) => (
              <UsageTreeNode
                key={root.nodeId}
                node={root}
                depth={0}
                expanded={expanded}
                onToggle={toggle}
                selectedNodeId={selectedNodeId}
                onSelect={select}
              />
            ))}
          </div>

          {selectedNode && (
            <div className="token-calls-list">
              <div className="token-calls-title">
                Chamadas — {nodeLabel(selectedNode)}
                {selectedNode.taskDescription ? ` (${selectedNode.taskDescription})` : ''}
              </div>
              {selectedNode.calls.length === 0 ? (
                <div className="token-usage-empty">Sem chamadas diretas neste nó.</div>
              ) : (
                <ul>
                  {selectedNode.calls.map((call) => (
                    <li key={call.seq}>
                      <button
                        type="button"
                        className={`token-call-row${selectedSeq === call.seq ? ' selected' : ''}`}
                        onClick={() => setSelectedSeq(call.seq)}
                      >
                        <span>{call.model}</span>
                        <TokenBadges t={call.tokens} />
                        <span className="token-call-time">
                          {new Date(call.createdAt).toLocaleTimeString('pt-BR')}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {selectedCall && (
            <div className="token-call-detail">
              <div>
                <strong>Entrada</strong>
                <pre>{selectedCall.inputPreview || '(vazio)'}</pre>
              </div>
              <div>
                <strong>Saída</strong>
                <pre>{selectedCall.outputPreview || '(vazio)'}</pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Exportado só para o teste (evita reimplementar o cálculo de nós na suíte).
export const __internal = { allNodeIds }
