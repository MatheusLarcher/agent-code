import { describe, expect, it } from 'vitest'
import type { ChatEvent, TokenUsage } from '@shared/ipc'
import { buildUsageTree, emptyUsageMap, reduceUsage, totalTokens } from './tokenUsageTree'

function usage(input: number, output: number): TokenUsage {
  return { input, output, cacheRead: 0, cacheWrite: 0 }
}

function llmCall(over: Partial<Extract<ChatEvent, { kind: 'llm-call' }>>): ChatEvent {
  return {
    kind: 'llm-call',
    node_id: 'root-1',
    parent_node_id: null,
    seq: 0,
    model: 'claude-sonnet',
    tokens: usage(100, 50),
    inputPreview: 'hi',
    outputPreview: 'hello',
    createdAt: 1,
    ...over
  }
}

describe('tokenUsageTree', () => {
  it('builds a single root node from one llm-call', () => {
    const map = reduceUsage(emptyUsageMap, llmCall({}))
    const tree = buildUsageTree(map)
    expect(tree).toHaveLength(1)
    expect(tree[0].nodeId).toBe('root-1')
    expect(tree[0].parentNodeId).toBeNull()
    expect(tree[0].calls).toHaveLength(1)
    expect(tree[0].children).toHaveLength(0)
  })

  it('nests one level of subagent under the root', () => {
    let map = emptyUsageMap
    map = reduceUsage(map, llmCall({ node_id: 'root-1', parent_node_id: null, seq: 0 }))
    map = reduceUsage(
      map,
      llmCall({
        node_id: 'sub-1',
        parent_node_id: 'root-1',
        seq: 0,
        subagentType: 'Explore'
      })
    )
    const tree = buildUsageTree(map)
    expect(tree).toHaveLength(1)
    expect(tree[0].nodeId).toBe('root-1')
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children[0].nodeId).toBe('sub-1')
    expect(tree[0].children[0].subagentType).toBe('Explore')
  })

  it('nests 2+ levels — a subagent calling another subagent', () => {
    let map = emptyUsageMap
    map = reduceUsage(map, llmCall({ node_id: 'root-1', parent_node_id: null, seq: 0 }))
    map = reduceUsage(map, llmCall({ node_id: 'sub-1', parent_node_id: 'root-1', seq: 0 }))
    map = reduceUsage(map, llmCall({ node_id: 'sub-2', parent_node_id: 'sub-1', seq: 0 }))
    map = reduceUsage(map, llmCall({ node_id: 'sub-3', parent_node_id: 'sub-2', seq: 0 }))

    const tree = buildUsageTree(map)
    expect(tree).toHaveLength(1)
    const root = tree[0]
    expect(root.nodeId).toBe('root-1')
    expect(root.children[0].nodeId).toBe('sub-1')
    expect(root.children[0].children[0].nodeId).toBe('sub-2')
    expect(root.children[0].children[0].children[0].nodeId).toBe('sub-3')

    const totals = totalTokens(root)
    // 4 calls of (100, 50) each rolled up through the whole subtree.
    expect(totals.input).toBe(400)
    expect(totals.output).toBe(200)
  })

  it('accumulates multiple calls on the same node, sorted by seq', () => {
    let map = emptyUsageMap
    map = reduceUsage(map, llmCall({ node_id: 'root-1', seq: 2, model: 'third' }))
    map = reduceUsage(map, llmCall({ node_id: 'root-1', seq: 0, model: 'first' }))
    map = reduceUsage(map, llmCall({ node_id: 'root-1', seq: 1, model: 'second' }))

    const tree = buildUsageTree(map)
    expect(tree[0].calls.map((c) => c.model)).toEqual(['first', 'second', 'third'])
  })

  it('handles an out-of-order event: child arrives before its parent node', () => {
    let map = emptyUsageMap
    // The subagent's call streams in first (its parent Task tool-use hasn't
    // produced a call yet), then the root's own call arrives afterward.
    map = reduceUsage(map, llmCall({ node_id: 'sub-1', parent_node_id: 'root-1', seq: 0 }))
    // Before the root exists, sub-1 has no known parent, so it's a root by itself.
    let tree = buildUsageTree(map)
    expect(tree).toHaveLength(1)
    expect(tree[0].nodeId).toBe('sub-1')

    map = reduceUsage(map, llmCall({ node_id: 'root-1', parent_node_id: null, seq: 0 }))
    tree = buildUsageTree(map)
    // Once root-1 shows up, sub-1 is reattached under it instead of staying a root.
    expect(tree).toHaveLength(1)
    expect(tree[0].nodeId).toBe('root-1')
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children[0].nodeId).toBe('sub-1')
  })

  it('ignores non llm-call events', () => {
    const map = reduceUsage(emptyUsageMap, { kind: 'status', id: '1', text: 'x' })
    expect(map).toBe(emptyUsageMap)
  })
})
