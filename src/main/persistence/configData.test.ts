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

  it('mantém o TypeSafe DESLIGADO por padrão e faz merge profundo do bloco', () => {
    // Serviço externo e pago, com chave do usuário: não pode ligar sozinho.
    expect(defaultAppConfig().typesafe).toEqual({
      enabled: false,
      apiKey: '',
      minConfidence: 0.2,
      allowedAutoModels: []
    })
    expect(parseStoredAppConfig('{}').typesafe.enabled).toBe(false)

    // Gravar só o interruptor não pode apagar a chave (armadilha do spread raso).
    const comChave = mergeAppConfig(defaultAppConfig(), { typesafe: { apiKey: 'ts-key' } })
    expect(mergeAppConfig(comChave, { typesafe: { enabled: true } }).typesafe).toEqual({
      enabled: true,
      apiKey: 'ts-key',
      minConfidence: 0.2,
      allowedAutoModels: []
    })

    // Limiar fora de 0..1 não significa nada: ou cala o serviço, ou aceita chute.
    expect(() => mergeAppConfig(defaultAppConfig(), { typesafe: { minConfidence: 1.5 } })).toThrow()
    expect(() => mergeAppConfig(defaultAppConfig(), { typesafe: { enabled: 'sim' } })).toThrow()
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
