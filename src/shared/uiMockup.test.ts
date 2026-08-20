import { describe, expect, it } from 'vitest'
import type { UiMockupArtifact, UiMockupSeed } from './ipc'
import {
  isRenderUiMockupToolName,
  isSafeUiMockupArtifact,
  isSafeUiMockupSeed,
  latestUiMockupSeeds,
  normalizeUiMockupTitle,
  UI_MOCKUP_CSP
} from './uiMockup'

function safeDocument(body = '<p>Safe preview</p>'): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${UI_MOCKUP_CSP}"><style>.wmd-root{color:#333}</style></head><body class="wmd-root wmd-clean">${body}</body></html>`
}

function artifact(overrides: Partial<UiMockupArtifact> = {}): UiMockupArtifact {
  return {
    type: 'ui_mockup',
    id: 'artifact-1',
    version: 1,
    title: 'Atendimento',
    source: '# Atendimento',
    html: safeDocument(),
    viewport: 'desktop',
    ...overrides
  }
}

describe('ui mockup runtime validation', () => {
  it('accepts complete safe artifacts and the smaller seed shape', () => {
    const value = artifact()
    const seed: UiMockupSeed = {
      id: value.id,
      version: value.version,
      title: value.title,
      source: value.source,
      viewport: value.viewport
    }
    expect(isSafeUiMockupArtifact(value)).toBe(true)
    expect(isSafeUiMockupSeed(seed)).toBe(true)
    expect(isSafeUiMockupArtifact(artifact({
      html: safeDocument('<p>Visible text may say data = 10 or url(example).</p>')
    }))).toBe(true)
  })

  it.each([
    ['missing id', artifact({ id: '' })],
    ['oversized id', artifact({ id: 'x'.repeat(129) })],
    ['invalid version', artifact({ version: 0 })],
    ['empty title', artifact({ title: '   ' })],
    ['oversized title', artifact({ title: 'x'.repeat(81) })],
    ['title with control character', artifact({ title: 'Painel\nquebrado' })],
    ['empty source', artifact({ source: '' })],
    ['oversized source', artifact({ source: 'x'.repeat(2_501) })],
    ['invalid viewport', artifact({ viewport: 'tablet' as 'desktop' })],
    ['oversized html', artifact({ html: 'x'.repeat(250_001) })]
  ])('rejects an artifact with %s', (_name, value) => {
    expect(isSafeUiMockupArtifact(value)).toBe(false)
  })

  it.each([
    ['missing CSP', '<!doctype html><html><head></head><body>Unsafe</body></html>'],
    ['changed CSP', safeDocument().replace(UI_MOCKUP_CSP, "default-src 'self'")],
    ['forged CSP attribute', safeDocument().replace(' content="default-src', ' data-content="default-src')],
    ['script', safeDocument('<script>alert(1)</script>')],
    ['iframe', safeDocument('<iframe src="https://example.com"></iframe>')],
    ['event handler', safeDocument('<div onclick="alert(1)">Unsafe</div>')],
    ['external href', safeDocument('<a href="https://example.com">Unsafe</a>')],
    ['external srcset', safeDocument('<img srcset="https://example.com/pixel">')],
    ['SVG navigation animation', safeDocument('<svg><a><animate attributeName="href" values="https://example.com/landing"></animate></a></svg>')],
    ['oversized layout attribute', safeDocument('<textarea rows="999999999" placeholder="Description"></textarea>')],
    ['content before CSP', safeDocument().replace('<meta charset="utf-8">', '<img srcset="https://example.com/pixel"><meta charset="utf-8">')],
    ['remote CSS', safeDocument('<style>.x{background:url(https://example.com/x)}</style>')],
    ['meta refresh', safeDocument('<meta http-equiv="refresh" content="0;url=https://example.com">')]
  ])('rejects persisted HTML containing %s', (_name, html) => {
    expect(isSafeUiMockupArtifact(artifact({ html }))).toBe(false)
  })

  it('rejects nested documents and extra metadata', () => {
    expect(isSafeUiMockupArtifact(artifact({ html: safeDocument('<html><body>Nested</body></html>') }))).toBe(false)
    expect(isSafeUiMockupArtifact(artifact({
      html: safeDocument().replace('</head>', '<meta name="extra" content="x"></head>')
    }))).toBe(false)
  })
})

describe('ui mockup tool names', () => {
  it('matches only the local and fully-qualified MCP names', () => {
    expect(isRenderUiMockupToolName('render_ui_mockup')).toBe(true)
    expect(isRenderUiMockupToolName('mcp__wiremd__render_ui_mockup')).toBe(true)
    expect(isRenderUiMockupToolName('evil__render_ui_mockup')).toBe(false)
    expect(isRenderUiMockupToolName('Render_Ui_Mockup')).toBe(false)
    expect(isRenderUiMockupToolName(null)).toBe(false)
  })
})

describe('latestUiMockupSeeds', () => {
  it('normalizes titles, keeps the highest version and returns every title newest first', () => {
    const values: unknown[] = [
      artifact({ id: 'a-old', title: ' Atendimento ', version: 1 }),
      artifact({ id: 'b', title: 'Financeiro', version: 1 }),
      { kind: 'ui-mockup', artifact: artifact({ id: 'a-new', title: 'ATENDIMENTO', version: 3 }) },
      artifact({ id: 'c', title: 'Agenda', version: 2, viewport: 'mobile' }),
      artifact({ id: 'd', title: 'Pacientes', version: 1 })
    ]

    expect(normalizeUiMockupTitle('ＡTENDIMENTO ')).toBe('atendimento')
    expect(normalizeUiMockupTitle('Painel   de\n atendimento')).toBe('painel de atendimento')
    expect(latestUiMockupSeeds(values)).toEqual([
      expect.objectContaining({ id: 'd', title: 'Pacientes', version: 1 }),
      expect.objectContaining({ id: 'c', title: 'Agenda', version: 2, viewport: 'mobile' }),
      expect.objectContaining({ id: 'a-new', title: 'ATENDIMENTO', version: 3 }),
      expect.objectContaining({ id: 'b', title: 'Financeiro', version: 1 })
    ])
  })

  it('ignores unsafe artifacts instead of accepting their seed-compatible fields', () => {
    const unsafe = artifact({ id: 'unsafe', html: '<script>alert(1)</script>' })
    const seed: UiMockupSeed = {
      id: 'seed-only', version: 2, title: 'Seed', source: '# Seed', viewport: 'desktop'
    }
    expect(latestUiMockupSeeds([unsafe, { kind: 'ui-mockup', artifact: unsafe }, seed])).toEqual([seed])
  })
})
