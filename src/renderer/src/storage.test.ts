import { afterEach, describe, expect, it, vi } from 'vitest'
import { compactOldConversations, loadConversations, saveConversations } from './storage'
import type { Conversation, UIMessage } from './types'
import { UI_MOCKUP_CSP } from '@shared/uiMockup'

const now = 2_000_000_000_000

function safeHtml(body = '<p>Profile</p>'): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${UI_MOCKUP_CSP}"><style>.wmd-root{color:#333}</style></head><body class="wmd-root wmd-clean">${body}</body></html>`
}

function mockupMessage(html = safeHtml()): Extract<UIMessage, { kind: 'ui-mockup' }> {
  return {
    kind: 'ui-mockup',
    parentToolUseId: null,
    artifact: {
      type: 'ui_mockup', id: 'a1', version: 1, title: 'Profile', source: '# Profile',
      html, viewport: 'desktop'
    }
  }
}

function conversation(messages?: UIMessage[], ageDays = 16): Conversation {
  return {
    id: 'c1', title: 'Mockup', cwd: 'C:\\project', model: 'claude', sdkSessionId: 's1',
    messages: messages ?? [
      { kind: 'tool-use', id: 't1', name: 'render_ui_mockup', input: {}, parentToolUseId: null },
      { kind: 'tool-result', id: 'r1', toolUseId: 't1', isError: false, text: 'hidden source' },
      mockupMessage()
    ],
    tokens: { context: 0, output: 0, cost: 0 },
    createdAt: now - ageDays * 24 * 60 * 60 * 1000,
    updatedAt: now
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('conversation artifact persistence', () => {
  it('keeps safe ui mockups during compaction without persisting their tool call or result', () => {
    const [saved] = compactOldConversations([conversation()], now)
    expect(saved.messages).toHaveLength(1)
    expect(saved.messages[0]).toMatchObject({
      kind: 'ui-mockup',
      artifact: { id: 'a1', source: '# Profile', html: safeHtml() }
    })
  })

  it('filters unsafe ui mockups even before a conversation is old enough to compact', () => {
    const messages: UIMessage[] = [
      mockupMessage(),
      mockupMessage('<!doctype html><html><head></head><body><script>alert(1)</script></body></html>'),
      { kind: 'assistant-text', id: 'answer', text: 'done', final: true }
    ]
    const [saved] = compactOldConversations([conversation(messages, 1)], now)
    expect(saved.messages).toEqual([messages[0], messages[2]])
  })

  it('never persists or restores a subagent mockup as main-conversation state', () => {
    const child = { ...mockupMessage(), parentToolUseId: 'task-child' }
    const [saved] = compactOldConversations([
      conversation([mockupMessage(), child], 1)
    ], now)

    expect(saved.messages).toEqual([mockupMessage()])
  })

  it('filters unsafe artifacts and hidden mockup tool messages while loading', async () => {
    const messages: UIMessage[] = [
      { kind: 'tool-use', id: 'qualified', name: 'mcp__wiremd__render_ui_mockup', input: { source: 'secret' }, parentToolUseId: null },
      { kind: 'tool-result', id: 'result', toolUseId: 'qualified', isError: false, text: 'secret result' },
      mockupMessage(),
      mockupMessage('<script>alert(1)</script>')
    ]
    const loadAllConversations = vi.fn().mockResolvedValue([conversation(messages, 1)])
    vi.stubGlobal('window', { api: { loadAllConversations } })

    const loaded = await loadConversations()

    expect(loaded).toHaveLength(1)
    expect(loaded[0].messages).toEqual([messages[2]])
  })

  it('filters unsafe artifacts and hidden mockup tool messages before saving', async () => {
    const messages: UIMessage[] = [
      { kind: 'tool-use', id: 'raw', name: 'render_ui_mockup', input: { source: 'secret' }, parentToolUseId: null },
      { kind: 'tool-result', id: 'result', toolUseId: 'raw', isError: false, text: 'secret result' },
      mockupMessage(),
      mockupMessage('<iframe src="https://example.com"></iframe>')
    ]
    const saveAllConversations = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { saveAllConversations } })

    await saveConversations([conversation(messages, 1)])

    expect(saveAllConversations).toHaveBeenCalledOnce()
    const persisted = saveAllConversations.mock.calls[0][0] as Conversation[]
    expect(persisted[0].messages).toEqual([messages[2]])
  })
})
