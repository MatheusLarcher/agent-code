import { useEffect, useMemo, useState } from 'react'
import type { LlmCall as PersistedLlmCall, LlmUsageTotal, TokenUsage } from '@shared/ipc'
import { buildUsageTree, totalTokens, type UsageMap, type UsageNode } from '../tokenUsageTree'
import { buildHistoryMap, fmtCost, mergeUsageMaps, usageTotals } from '../tokenUsageHistory'
import { IconChevronDown, IconChevronRight } from './Icons'
import { ReadRetry } from './ReadRetry'

interface Props {
  /** Conversa aberta no momento, ou `null` sem conversa selecionada. */
  convId: string | null
  /** Acumulador ao vivo desta conversa, alimentado pelos eventos `llm-call`
   *  que chegam enquanto o app está aberto (ver App.tsx). */
  liveMap: UsageMap
  /** O custo da conversa em dólar: aparece no cabeçalho (o chat flutuante do Escritório,
   *  que não tem mais a pílula de custo). Sem ele, o cabeçalho é o de sempre. */
  cost?: number
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

export function TokenUsagePanel({ convId, liveMap, cost }: Props): JSX.Element {
  const [history, setHistory] = useState<{ calls: PersistedLlmCall[]; totals: LlmUsageTotal[] }>({
    calls: [],
    totals: []
  })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
  // Histórico do banco que falhou ou passou do prazo: o painel fica com o consumo
  // ao vivo e oferece "tentar de novo".
  const [historyError, setHistoryError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setSelectedNodeId(null)
    setSelectedSeq(null)
    setHistoryError(null)
    if (!convId) {
      setHistory({ calls: [], totals: [] })
      return
    }
    let cancelled = false
    window.api
      .getTokenUsageHistory(convId)
      .then((h) => {
        if (!cancelled) setHistory(h)
      })
      .catch((error: unknown) => {
        if (!cancelled) setHistoryError(error)
      })
    return () => {
      cancelled = true
    }
  }, [convId, attempt])

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

  // O total da conversa: o do banco (guarda também o que a poda já apagou) e as chamadas ao vivo que ele ainda não conhecia.
  const grandTotal = useMemo(() => usageTotals(history, liveMap).tokens, [history, liveMap])

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
        {cost !== undefined && (
          <span className="token-usage-cost" title="Custo da conversa, como o Claude informou">
            {fmtCost(cost)}
          </span>
        )}
        <span className="token-usage-call-count">{totalCalls} chamada{totalCalls === 1 ? '' : 's'}</span>
      </div>

      {historyError ? (
        <ReadRetry error={historyError} what="o histórico de consumo" onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}

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
