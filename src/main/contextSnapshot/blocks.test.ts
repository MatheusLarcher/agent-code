// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { composeUserPrompt } from '../promptEnvelope'
import { composeFromPromptBlocks, maskText, promptBlocks } from './blocks'
import { secretPlaceholder } from '../../shared/contextSnapshot'

describe('context blocks', () => {
  const parts = { stamp: 'stamp', memory: 'memory', skills: 'skills', projects: 'projects', others: 'others', reminder: 'reminder' }
  it.each(['', 'pedido', '/loop pedido', '  /loop  pedido', '/loop', 'nota\n\npedido', '/loop nota\n\npedido'])('reconstitui composeUserPrompt: %s', (body) => {
    expect(composeFromPromptBlocks(promptBlocks(body, parts, 'nota'))).toBe(composeUserPrompt(body, parts))
  })
  it('varre segredos sobrepostos uma vez, preservando marcadores', () => {
    expect(maskText('ab a s', 'docs', [
      { name: 'senha', value: 's' }, { name: 'short', value: 'a' }, { name: 'long', value: 'ab' }
    ])).toBe('⟦senha:long⟧ ⟦senha:short⟧ ⟦senha:senha⟧')
    expect(maskText('a.b', 'docs', [{ name: 'dot', value: 'a.b' }, { name: 'empty', value: '' }])).toBe('⟦senha:dot⟧')
  })
  it.each(['X', 'YZ', 'UVW', 'senha-real'])('mascara valor curto ou longo %s sem alterar marcador', (value) => {
    const secret = { name: 'vault', value }
    expect(maskText(`antes ${value} depois ${value}`, 'docs', [secret])).toBe(`antes ${secretPlaceholder('vault')} depois ${secretPlaceholder('vault')}`)
  })
})
