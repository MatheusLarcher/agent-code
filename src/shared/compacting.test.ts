import { describe, expect, it } from 'vitest'
import { compactFailedText, readCompactStatus } from './compacting'

describe('readCompactStatus', () => {
  it('compacting → início; status nulo → fim; falha traz o erro', () => {
    expect(readCompactStatus({ type: 'system', subtype: 'status', status: 'compacting' })).toEqual({ phase: 'start' })
    expect(readCompactStatus({ type: 'system', subtype: 'status', status: null, compact_result: 'success' })).toEqual({ phase: 'end', failed: false })
    expect(readCompactStatus({ type: 'system', subtype: 'status', status: null })).toEqual({ phase: 'end', failed: false })
    expect(
      readCompactStatus({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'x' })
    ).toEqual({ phase: 'end', failed: true, error: 'x' })
  })

  it('ignora o que não fala de compactação', () => {
    expect(readCompactStatus({ type: 'system', subtype: 'status', status: 'requesting' })).toBeNull()
    expect(readCompactStatus({ type: 'system', subtype: 'init' })).toBeNull()
    expect(readCompactStatus({ type: 'assistant' })).toBeNull()
    expect(readCompactStatus(null)).toBeNull()
  })

  it('texto da falha com e sem detalhe', () => {
    expect(compactFailedText()).toBe('A compactação falhou. A conversa segue sem compactar.')
    expect(compactFailedText('y')).toBe('A compactação falhou: y. A conversa segue sem compactar.')
  })
})
