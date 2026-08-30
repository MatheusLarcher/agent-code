import { describe, expect, it } from 'vitest'
import { defaultAppConfig, mergeAppConfig, parseStoredAppConfig } from './configData'

describe('configuração persistida', () => {
  it('preenche campos ausentes e faz merge profundo dos grupos', () => {
    const parsed = parseStoredAppConfig(
      JSON.stringify({
        openai: { apiKey: 'key' },
        localSpeech: { model: 'modelo' },
        ollama: { enabled: true }
      })
    )
    expect(parsed.openai).toMatchObject({ apiKey: 'key', voice: 'alloy', speed: 1 })
    expect(parsed.localSpeech.model).toBe('modelo')
    expect(parsed.ollama).toEqual({ enabled: true, apiKey: '' })
  })

  it('rejeita tipos inválidos em vez de transformar corrupção em defaults', () => {
    expect(() => parseStoredAppConfig('{')).toThrow('não é um JSON válido')
    expect(() => parseStoredAppConfig(JSON.stringify({ remoteEnabled: 'sim' }))).toThrow(
      'Configuração do Agent Code inválida'
    )
  })

  it('não altera o snapshot anterior quando o patch é inválido', () => {
    const current = defaultAppConfig()
    expect(() => mergeAppConfig(current, { openai: { speed: -1 } })).toThrow()
    expect(current).toEqual(defaultAppConfig())
  })
})
