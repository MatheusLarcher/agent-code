import { describe, expect, it } from 'vitest'
import { chromeGateDecision } from './gate'

describe('gate do controle do Chrome', () => {
  it('toggle desligado (ou corrompido) nega qualquer ferramenta chrome', () => {
    expect(chromeGateDecision('mcp__chrome__chrome_snapshot', false)).toBe('deny')
    expect(chromeGateDecision('mcp__chrome__chrome_click', undefined)).toBe('deny')
    expect(chromeGateDecision('mcp__chrome__chrome_click', 'true')).toBe('deny')
  })
  it('ligado: leitura libera, escrita segue o fluxo normal', () => {
    for (const t of ['status', 'list_tabs', 'snapshot', 'screenshot', 'scroll', 'wait']) {
      expect(chromeGateDecision(`mcp__chrome__chrome_${t}`, true)).toBe('allow')
    }
    expect(chromeGateDecision('mcp__chrome__chrome_click', true)).toBeNull()
    expect(chromeGateDecision('mcp__chrome__chrome_evaluate', true)).toBeNull()
  })
  it('ignora ferramentas de outros servidores', () => {
    expect(chromeGateDecision('Bash', false)).toBeNull()
    expect(chromeGateDecision('mcp__browser__browser_click', false)).toBeNull()
  })
})
