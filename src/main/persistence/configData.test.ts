import { describe, expect, it } from 'vitest'
import { defaultAppConfig, mergeAppConfig, parseStoredAppConfig } from './configData'

describe('configuração persistida', () => {
  it('mantém o cofre DESLIGADO por padrão e preserva a ativação explícita', () => {
    // Ligado, as senhas guardadas vão em texto puro no prompt e chegam ao
    // provedor. Isso não pode ser o padrão — só acontece se o usuário marcar.
    expect(defaultAppConfig().secretVaultEnabled).toBe(false)
    expect(parseStoredAppConfig('{}').secretVaultEnabled).toBe(false)
    const enabled = mergeAppConfig(defaultAppConfig(), { secretVaultEnabled: true })
    expect(parseStoredAppConfig(JSON.stringify(enabled)).secretVaultEnabled).toBe(true)
    expect(mergeAppConfig(enabled, { skipPermissions: true }).secretVaultEnabled).toBe(true)
    expect(() => mergeAppConfig(enabled, { secretVaultEnabled: 'true' })).toThrow()
  })

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
