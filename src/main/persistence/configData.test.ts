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
    expect(normalizeAllowedAutoModels(['claude-sonnet-5-5', 'claude-opus-5-5'])).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5'])
    expect(normalizeAllowedAutoModels(['claude-sonnet-5-5', 'claude-sonnet-5-5'])).toEqual(['claude-sonnet-5-5'])
    expect(normalizeAllowedAutoModels([])).toEqual([])
    for (const invalido of [undefined, null, 'claude-sonnet-5-5', 42, { a: 1 }, [1], ['claude-sonnet-5-5', 2], ['  ']]) {
      expect(normalizeAllowedAutoModels(invalido), JSON.stringify(invalido)).toEqual([])
    }

    // Merge pelo bloco preserva a lista ao gravar só o interruptor.
    const comLista = mergeAppConfig(defaultAppConfig(), { typesafe: { allowedAutoModels: ['claude-sonnet-5-5'] } })
    expect(mergeAppConfig(comLista, { typesafe: { enabled: true } }).typesafe.allowedAutoModels).toEqual(['claude-sonnet-5-5'])
    // Na fronteira (IPC), item que não é texto continua sendo recusado.
    expect(() => mergeAppConfig(defaultAppConfig(), { typesafe: { allowedAutoModels: [1] } })).toThrow()

    // Mexer na lista de um default não mexe no DEFAULT_CONFIG nem no próximo default.
    defaultAppConfig().typesafe.allowedAutoModels.push('mutado')
    expect(DEFAULT_CONFIG.typesafe.allowedAutoModels).toEqual([])
    expect(defaultAppConfig().typesafe.allowedAutoModels).toEqual([])
  })

  it('planejamento: Automático nas duas dimensões por padrão, merge por campo', () => {
    expect(defaultAppConfig().planning).toEqual({ model: 'auto', effort: 'auto' })
    expect(parseStoredAppConfig('{}').planning).toEqual({ model: 'auto', effort: 'auto' })
    // O sentinel do esforço é valor válido, não corrupção.
    expect(mergeAppConfig(defaultAppConfig(), { planning: { model: 'claude-sonnet-5-5', effort: 'auto' } }).planning).toEqual({
      model: 'claude-sonnet-5-5',
      effort: 'auto'
    })

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
    const atual = mergeAppConfig(defaultAppConfig(), { planning: { model: 'claude-sonnet-5-5', effort: 'high' } })

    expect(mergeAppConfig(atual, { planning: { model: 'claude-opus-4-1' } }).planning).toEqual({
      model: 'auto',
      effort: 'high'
    })
    expect(mergeAppConfig(atual, { planning: { effort: 'ultra' } }).planning).toEqual({
      model: 'claude-sonnet-5-5',
      effort: 'auto'
    })
    // Tipo errado também normaliza em vez de lançar: cada campo é aplicado
    // sozinho no boot, e lançar ali derrubaria a abertura do app.
    expect(mergeAppConfig(atual, { planning: { model: 42, effort: null } }).planning).toEqual({
      model: 'auto',
      effort: 'auto'
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
        voice: { speed: 1.25 },
        localSpeech: { model: 'modelo' },
        ollama: { enabled: true }
      })
    )
    expect(parsed.voice).toEqual({ voice: 'pf_dora', speed: 1.25, whisperModel: 'turbo-q8' })
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
    expect(() => mergeAppConfig(current, { voice: { speed: -1 } })).toThrow()
    expect(current).toEqual(defaultAppConfig())
  })

  it('migra a voz da OpenAI: chave descartada, voz antiga → pf_dora, cloud → whisper', () => {
    const parsed = parseStoredAppConfig(
      JSON.stringify({ openai: { apiKey: 'sk-velha', voice: 'nova', speed: 1.5 }, transcribeEngine: 'cloud' })
    )
    expect(parsed).not.toHaveProperty('openai')
    expect(JSON.stringify(parsed)).not.toContain('sk-velha')
    expect(parsed.voice).toEqual({ voice: 'pf_dora', speed: 1.5, whisperModel: 'turbo-q8' })
    expect(parsed.transcribeEngine).toBe('whisper')
    // Campos gravados um a um (KV) também passam pelo merge.
    const atual = defaultAppConfig()
    expect(mergeAppConfig(atual, { transcribeEngine: 'cloud' }).transcribeEngine).toBe('whisper')
    expect(mergeAppConfig(atual, { voice: { voice: 'alloy' } }).voice.voice).toBe('pf_dora')
    expect(mergeAppConfig(atual, { voice: { voice: 'pm_santa', speed: 9 } }).voice).toEqual({ voice: 'pm_santa', speed: 2, whisperModel: 'turbo-q8' })
    expect(mergeAppConfig(atual, { transcribeEngine: 'local' }).transcribeEngine).toBe('local')
  })

  it('padrão: pf_dora, velocidade 1, ditado com Whisper local large-v3-turbo', () => {
    const d = defaultAppConfig()
    expect(d.voice).toEqual({ voice: 'pf_dora', speed: 1, whisperModel: 'turbo-q8' })
    expect(d.transcribeEngine).toBe('whisper')
  })

  it('modelo do Whisper: small é aceito; desconhecido ou de tipo errado volta a turbo-q8', () => {
    const atual = defaultAppConfig()
    expect(mergeAppConfig(atual, { voice: { whisperModel: 'small-fp32' } }).voice.whisperModel).toBe('small-fp32')
    expect(mergeAppConfig(atual, { voice: { whisperModel: 'large-v9' } }).voice.whisperModel).toBe('turbo-q8')
    expect(mergeAppConfig(atual, { voice: { whisperModel: 42 } }).voice.whisperModel).toBe('turbo-q8')
    const small = mergeAppConfig(atual, { voice: { whisperModel: 'small-fp32' } })
    // Gravar só a velocidade não apaga a escolha do modelo (merge aninhado).
    expect(mergeAppConfig(small, { voice: { speed: 1.25 } }).voice.whisperModel).toBe('small-fp32')
  })
})
