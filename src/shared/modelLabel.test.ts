import { describe, expect, it } from 'vitest'
import { modelDisplayName, modelSequenceLabel } from './modelLabel'

describe('modelDisplayName', () => {
  it('usa o rótulo do seletor sem o sufixo entre parênteses', () => {
    expect(modelDisplayName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelDisplayName('gpt-6.1-sol')).toBe('GPT-6.1 Sol')
    expect(modelDisplayName('nemotron-3-ultra:cloud')).toBe('Nemotron 3 Ultra')
    expect(modelDisplayName('gpt-oss:20b-cloud')).toBe('GPT-OSS 20B')
  })

  it('id fora das listas aparece como veio; nada de prefixo nem id aposentado', () => {
    expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
    expect(modelDisplayName(' gpt-5.6-sol ')).toBe('gpt-5.6-sol')
    expect(modelDisplayName('claude-opus-5-5-20261001')).toBe('claude-opus-5-5-20261001')
  })

  it('vazio e o sentinela do Automático não viram nome', () => {
    expect(modelDisplayName('auto')).toBe('')
    expect(modelDisplayName('')).toBe('')
    expect(modelDisplayName('   ')).toBe('')
    expect(modelDisplayName(null)).toBe('')
    expect(modelDisplayName(undefined)).toBe('')
  })
})

describe('modelSequenceLabel', () => {
  it('nomes distintos na ordem em que entraram', () => {
    expect(modelSequenceLabel(['claude-opus-5-5', 'gpt-6.1-sol'])).toBe('Opus 5.5 → GPT-6.1 Sol')
    expect(modelSequenceLabel(['claude-opus-5-5', 'gpt-6.1-sol', 'claude-opus-5-5'])).toBe('Opus 5.5 → GPT-6.1 Sol')
  })

  it('pula vazio e Automático; lista vazia dá texto vazio', () => {
    expect(modelSequenceLabel(['', 'auto', 'claude-sonnet-5-5'])).toBe('Sonnet 5.5')
    expect(modelSequenceLabel([])).toBe('')
  })
})
