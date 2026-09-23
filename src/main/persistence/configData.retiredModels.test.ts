import { describe, expect, it } from 'vitest'
import { normalizeAllowedAutoModels } from './configData'

describe('lista do Automático com modelos aposentados', () => {
  it('GPT-5.6 salvo vira o substituto GPT-6, sem duplicar', () => {
    expect(normalizeAllowedAutoModels(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'claude-sonnet-5'])).toEqual([
      'gpt-6-luna',
      'gpt-6-sol',
      'claude-sonnet-5'
    ])
  })

  it('lista atual passa intacta', () => {
    expect(normalizeAllowedAutoModels(['gpt-6-astra', 'claude-opus-5-5'])).toEqual(['gpt-6-astra', 'claude-opus-5-5'])
  })
})
