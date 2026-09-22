import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../shared/ipc'
import { defaultAppConfig, mergeAppConfig, normalizeAllowedAutoModels, parseStoredAppConfig } from './configData'

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

  it('TypeSafe: lista do Automático normalizada campo a campo, e o padrão nunca é compartilhado', () => {
    expect(normalizeAllowedAutoModels(['claude-sonnet-5', 'claude-opus-5-5'])).toEqual(['claude-sonnet-5', 'claude-opus-5-5'])
    expect(normalizeAllowedAutoModels(['claude-sonnet-5', 'claude-sonnet-5'])).toEqual(['claude-sonnet-5'])
    expect(normalizeAllowedAutoModels([])).toEqual([])
    for (const invalido of [undefined, null, 'claude-sonnet-5', 42, { a: 1 }, [1], ['claude-sonnet-5', 2], ['  ']]) {
      expect(normalizeAllowedAutoModels(invalido), JSON.stringify(invalido)).toEqual([])
    }

    // Merge pelo bloco preserva a lista ao gravar só o interruptor.
    const comLista = mergeAppConfig(defaultAppConfig(), { typesafe: { allowedAutoModels: ['claude-sonnet-5'] } })
    expect(mergeAppConfig(comLista, { typesafe: { enabled: true } }).typesafe.allowedAutoModels).toEqual(['claude-sonnet-5'])
    // Na fronteira (IPC), item que não é texto continua sendo recusado.
    expect(() => mergeAppConfig(defaultAppConfig(), { typesafe: { allowedAutoModels: [1] } })).toThrow()

    // Mexer na lista de um default não mexe no DEFAULT_CONFIG nem no próximo default.
    defaultAppConfig().typesafe.allowedAutoModels.push('mutado')
    expect(DEFAULT_CONFIG.typesafe.allowedAutoModels).toEqual([])
    expect(defaultAppConfig().typesafe.allowedAutoModels).toEqual([])
  })

  it('planejamento: Automático + médio por padrão, merge por campo', () => {
    expect(defaultAppConfig().planning).toEqual({ model: 'auto', effort: 'medium' })
    expect(parseStoredAppConfig('{}').planning).toEqual({ model: 'auto', effort: 'medium' })

    // Gravar só o modelo não pode apagar o esforço (armadilha do spread raso).
    const comEsforco = mergeAppConfig(defaultAppConfig(), { planning: { effort: 'xhigh' } })
    expect(mergeAppConfig(comEsforco, { planning: { model: 'claude-fable-5-1' } }).planning).toEqual({
      model: 'claude-fable-5-1',
      effort: 'xhigh'
    })
    // O default nunca é o objeto compartilhado: mexer num não mexe no outro.
    expect(defaultAppConfig().planning).not.toBe(defaultAppConfig().planning)
  })

  it('planejamento: modelo fora de PLANNING_MODELS ou esforço fora de EFFORT_LEVELS volta ao padrão', () => {
    const atual = mergeAppConfig(defaultAppConfig(), { planning: { model: 'claude-sonnet-5', effort: 'high' } })

    expect(mergeAppConfig(atual, { planning: { model: 'claude-opus-4-1' } }).planning).toEqual({
      model: 'auto',
      effort: 'high'
    })
    expect(mergeAppConfig(atual, { planning: { effort: 'ultra' } }).planning).toEqual({
      model: 'claude-sonnet-5',
      effort: 'medium'
    })
    // Tipo errado também normaliza em vez de lançar: cada campo é aplicado
    // sozinho no boot, e lançar ali derrubaria a abertura do app.
    expect(mergeAppConfig(atual, { planning: { model: 42, effort: null } }).planning).toEqual({
      model: 'auto',
      effort: 'medium'
    })
    expect(parseStoredAppConfig(JSON.stringify({ planning: { model: 'gpt-x', effort: 'max' } })).planning).toEqual({
      model: 'auto',
      effort: 'max'
    })
    // Chave desconhecida dentro do bloco continua sendo corrupção.
    expect(() => mergeAppConfig(atual, { planning: { temperatura: 1 } })).toThrow()
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
