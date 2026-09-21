import type { ChatEvent, TokenUsage } from '@shared/ipc'

/**
 * Per-conversation token usage tree — the "Tokens" panel's data (see
 * docs/superpowers/specs/2026-09-19-arvore-consumo-tokens-design.md).
 *
 * Unlike `agentTracks.ts` (2 levels: main agent + direct subagent), nesting
 * here is arbitrary depth: a node's `parentNodeId` can point at ANOTHER
 * node's id, not just the root, because a subagent can delegate to a further
 * subagent. The tree is built lazily out of order — a call for a node can
 * arrive before the node that will turn out to be its parent — so lookups
 * never assume parents exist yet; the shape is reconciled at render time by
 * `buildUsageTree`, not by insertion order.
 *
 * This module is pure — no React, no IPC — so it is unit testable on its own.
 */

/** One real call to the model, kept in the order its events arrived. */
export interface LlmCall {
  seq: number
  model: string
  tokens: TokenUsage
  inputPreview: string
  outputPreview: string
  createdAt: number
}

/** One node of the tree: either the turn root or a subagent. */
export interface UsageNode {
  nodeId: string
  parentNodeId: string | null
  subagentType?: string
  taskDescription?: string
  calls: LlmCall[]
  children: UsageNode[]
}

/** Flat, order-independent accumulator — the state a conversation carries. */
export interface UsageMap {
  /** Every node seen so far, keyed by its id. Parents may not exist yet. */
  nodes: Record<string, UsageNode>
  /** Ids of nodes with no known parent among `nodes` — tree roots once built. */
  rootIds: string[]
}

export const emptyUsageMap: UsageMap = { nodes: {}, rootIds: [] }

function newNode(nodeId: string, parentNodeId: string | null): UsageNode {
  return { nodeId, parentNodeId, calls: [], children: [] }
}

/**
 * Fold one `llm-call` event into the accumulator. Returns the SAME map for
 * any other event, so callers can skip the state update.
 */
export function reduceUsage(map: UsageMap, e: ChatEvent): UsageMap {
  if (e.kind !== 'llm-call') return map

  const call: LlmCall = {
    seq: e.seq,
    model: e.model,
    tokens: e.tokens,
    inputPreview: e.inputPreview,
    outputPreview: e.outputPreview,
    createdAt: e.createdAt
  }

  const existing = map.nodes[e.node_id]
  const node: UsageNode = existing
    ? {
        ...existing,
        // A late subagentType/taskDescription beats a missing one; never
        // overwrite a known parent with a later, differently-reported one.
        subagentType: existing.subagentType ?? e.subagentType,
        taskDescription: existing.taskDescription ?? e.taskDescription,
        // The SDK may emit a corrected snapshot for the same model call while
        // the turn is still live. Sequence numbers identify the call within a
        // node, so replace that entry instead of inflating the displayed usage.
        calls: sortCalls([
          ...existing.calls.filter((previous) => previous.seq !== call.seq),
          call
        ])
      }
    : {
        ...newNode(e.node_id, e.parent_node_id),
        subagentType: e.subagentType,
        taskDescription: e.taskDescription,
        calls: [call]
      }

  const nodes = { ...map.nodes, [e.node_id]: node }
  const rootIds = computeRootIds(nodes)
  return { nodes, rootIds }
}

function sortCalls(calls: LlmCall[]): LlmCall[] {
  return [...calls].sort((a, b) => a.seq - b.seq)
}

/** A node is a root when it has no `parentNodeId`, or its parent isn't known yet. */
function computeRootIds(nodes: Record<string, UsageNode>): string[] {
  return Object.keys(nodes).filter((id) => {
    const parentId = nodes[id].parentNodeId
    return parentId == null || !nodes[parentId]
  })
}

/**
 * Build the nested tree (roots with recursive `children`) from the flat
 * accumulator. Pure projection — call it whenever the panel renders.
 */
export function buildUsageTree(map: UsageMap): UsageNode[] {
  function attach(nodeId: string): UsageNode {
    const node = map.nodes[nodeId]
    const children = Object.values(map.nodes)
      .filter((n) => n.parentNodeId === nodeId)
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
      .map((n) => attach(n.nodeId))
    return { ...node, children }
  }

  return map.rootIds
    .map((id) => attach(id))
    .sort((a, b) => (a.calls[0]?.createdAt ?? 0) - (b.calls[0]?.createdAt ?? 0))
}

/** Sum of tokens across a node and all of its descendants. */
export function totalTokens(node: UsageNode): TokenUsage {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  for (const call of node.calls) {
    input += call.tokens.input
    output += call.tokens.output
    cacheRead += call.tokens.cacheRead
    cacheWrite += call.tokens.cacheWrite
  }
  for (const child of node.children) {
    const t = totalTokens(child)
    input += t.input
    output += t.output
    cacheRead += t.cacheRead
    cacheWrite += t.cacheWrite
  }
  return { input, output, cacheRead, cacheWrite }
}
