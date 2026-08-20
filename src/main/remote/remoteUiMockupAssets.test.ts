import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type MockupHarness = {
  isSafeUiMockupArtifact: (artifact: unknown) => boolean
  reduce: (messages: unknown[], event: unknown) => unknown[]
  sanitizeRemoteMessages: (messages: unknown) => unknown[]
  renderUiMockup: (message: unknown) => HTMLElement | null
  renderMessages: () => void
  rememberLiveEvent: (convId: string, event: unknown) => void
  replayLiveEvents: (messages: unknown[], convId: string, afterSeq: number) => unknown[]
  liveEventCursor: () => number
  state: { messages: unknown[]; historyLoading: boolean }
}

const CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "font-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "media-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

function artifactHtml(body = '<h1>Seguro</h1>'): string {
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    '<style>body{color:#111}</style></head><body class="wmd-root wmd-clean">' + body + '</body></html>'
}

function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'ui_mockup',
    id: 'artifact-1',
    version: 1,
    title: 'Painel',
    source: '# Painel',
    html: artifactHtml(),
    viewport: 'mobile',
    ...overrides
  }
}

function loadHarness(): MockupHarness {
  document.head.innerHTML = `<style>${readFileSync(resolve(process.cwd(), 'smartfone-remote/www/styles.css'), 'utf8')}</style>`
  document.body.innerHTML = '<div id="messages"></div>'
  const path = resolve(process.cwd(), 'smartfone-remote/www/app.js')
  const script = readFileSync(path, 'utf8').replace(
    "document.addEventListener('DOMContentLoaded', init)",
    ''
  )
  window.eval(
    script +
      '\nwindow.__remoteMockupTest = {' +
      'isSafeUiMockupArtifact, reduce, sanitizeRemoteMessages, renderUiMockup, renderMessages, state,' +
      'rememberLiveEvent, replayLiveEvents, liveEventCursor: function () { return liveEventSeq }' +
      '};'
  )
  return (window as unknown as { __remoteMockupTest: MockupHarness }).__remoteMockupTest
}

describe('smartfone remote ui-mockup asset', () => {
  it('drops source-bearing mockup tool cards from live events and persisted history', () => {
    const api = loadHarness()
    const tool = {
      kind: 'tool-use',
      id: 'tool-1',
      name: 'mcp__wiremd__render_ui_mockup',
      input: { source: '# SEGREDO' }
    }

    expect(api.reduce([], tool)).toEqual([])
    expect(api.sanitizeRemoteMessages([tool, { kind: 'ui-mockup', artifact: artifact() }])).toHaveLength(1)
  })

  it('renders one sandboxed srcdoc iframe without exposing raw WireMD', () => {
    const api = loadHarness()
    const node = api.renderUiMockup({ kind: 'ui-mockup', artifact: artifact() })

    expect(node).not.toBeNull()
    expect(node?.querySelectorAll('iframe')).toHaveLength(1)
    const frame = node?.querySelector('iframe') as HTMLIFrameElement
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame.srcdoc).toContain("default-src 'none'")
    expect(getComputedStyle(frame).pointerEvents).toBe('auto')
    expect(node?.textContent).not.toContain('# Painel')
  })

  it('keeps the same iframe alive across streaming deltas and does not stamp the previous text turn', () => {
    const api = loadHarness()
    const event = { kind: 'ui-mockup', artifact: artifact(), parentToolUseId: null }
    const messagesBox = document.getElementById('messages')!
    Object.defineProperty(messagesBox, 'clientWidth', { configurable: true, value: 300 })
    api.state.messages = [event]
    api.renderMessages()
    const frame = document.querySelector('iframe') as HTMLIFrameElement
    const portraitTransform = frame.style.transform

    api.reduce(api.state.messages, { kind: 'assistant-text', id: 'stream', text: 'A', final: false })
    api.renderMessages()
    expect(document.querySelector('iframe')).toBe(frame)
    api.reduce(api.state.messages, { kind: 'assistant-text', id: 'stream', text: 'AB', final: false })
    Object.defineProperty(messagesBox, 'clientWidth', { configurable: true, value: 700 })
    api.renderMessages()
    expect(document.querySelector('iframe')).toBe(frame)
    expect(frame.style.transform).not.toBe(portraitTransform)

    const prior = { kind: 'assistant-text', id: 'prior', text: 'Anterior', final: true, answer: false }
    const messages = [prior, { kind: 'user', id: 'u1', text: 'Mostre' }, event]
    api.reduce(messages, { kind: 'result', id: 'r1', isError: false })
    expect(prior.answer).toBe(false)

    const short = { kind: 'assistant-text', id: 'short', text: 'Montei.', final: true, answer: false }
    const withPhrase = [prior, { kind: 'user', id: 'u2', text: 'Mostre' }, short, event]
    api.reduce(withPhrase, { kind: 'result', id: 'r2', isError: false })
    expect(withPhrase[2]).toMatchObject({ id: 'short', answer: true })
  })

  it('replays an SSE mockup over a history response that started earlier', () => {
    const api = loadHarness()
    const cursor = api.liveEventCursor()
    const event = { kind: 'ui-mockup', artifact: artifact(), parentToolUseId: null }
    api.rememberLiveEvent('c1', event)

    const merged = api.replayLiveEvents([
      { kind: 'user', id: 'u1', text: 'Mostre' }
    ], 'c1', cursor)
    expect(merged).toEqual([
      { kind: 'user', id: 'u1', text: 'Mostre' },
      event
    ])

    // If persistence already caught up, replay replaces the same revision
    // instead of duplicating the preview.
    expect(api.replayLiveEvents([event], 'c1', cursor)).toEqual([event])
  })

  it('rejects persisted HTML without the fixed isolation boundary', () => {
    const api = loadHarness()
    const nestedFrame = artifactHtml('<iframe src="https://example.com"></iframe>')
    const remoteCss = artifactHtml('<style>.x{background:url(https://example.com/pixel)}</style>')
    const externalSrcset = artifactHtml('<img srcset="https://example.com/pixel">')
    const animatedLink = artifactHtml('<svg><a><animate attributeName="href" values="https://example.com/landing"></animate></a></svg>')
    const oversizedRows = artifactHtml('<textarea rows="999999999" placeholder="Description"></textarea>')
    const beforeCsp = artifactHtml().replace(
      '<meta charset="utf-8">',
      '<img srcset="https://example.com/pixel"><meta charset="utf-8">'
    )

    expect(api.isSafeUiMockupArtifact(artifact({ html: '<h1>Sem CSP</h1>' }))).toBe(false)
    expect(api.renderUiMockup({ kind: 'ui-mockup', artifact: artifact({ html: nestedFrame }) })).toBeNull()
    expect(api.isSafeUiMockupArtifact(artifact({ html: remoteCss }))).toBe(false)
    expect(api.isSafeUiMockupArtifact(artifact({ html: externalSrcset }))).toBe(false)
    expect(api.isSafeUiMockupArtifact(artifact({ html: animatedLink }))).toBe(false)
    expect(api.isSafeUiMockupArtifact(artifact({ html: oversizedRows }))).toBe(false)
    expect(api.isSafeUiMockupArtifact(artifact({ html: beforeCsp }))).toBe(false)
  })
})
