import { describe, it, expect } from 'vitest'
import {
  contextLimitFor,
  modelSupportsFastMode,
  modelSupportsVision,
  CONTEXT_LIMITS,
  MODEL_EFFORT,
  DEFAULT_CONFIG,
  Channels
} from './ipc'

describe('controle do Windows — contrato compartilhado', () => {
  it('começa desligado e usa canais IPC independentes de permitir tudo', () => {
    expect(DEFAULT_CONFIG.windowsControlEnabled).toBe(false)
    expect(Channels.windowsControlSetEnabled).not.toBe(Channels.configSet)
    expect(Channels.windowsControlChanged).toBe('windows-control:changed')
  })
})

describe('contextLimitFor — janelas de contexto reais dos modelos', () => {
  it('Claude: Opus/Sonnet/Fable = 1M, Haiku = 200K', () => {
    expect(contextLimitFor('claude-opus-4-8')).toBe(1_000_000)
    expect(contextLimitFor('claude-sonnet-5')).toBe(1_000_000)
    expect(contextLimitFor('claude-fable-5-1')).toBe(1_000_000)
    expect(contextLimitFor('claude-fable-5')).toBe(1_000_000)
    expect(contextLimitFor('claude-haiku-4-5')).toBe(200_000)
  })

  it('Ollama Cloud: GLM-5.2 e Kimi K3 são 1M nativos (não 128K/200K)', () => {
    expect(contextLimitFor('glm-5.2:cloud')).toBe(1_000_000)
    expect(contextLimitFor('kimi-k3:cloud')).toBe(1_000_000)
  })

  it('Ollama Cloud: Nemotron/Gemma 256K, gpt-oss e Muse Glimmer 128K', () => {
    expect(contextLimitFor('nemotron-3-ultra:cloud')).toBe(256_000)
    expect(contextLimitFor('gpt-oss:120b-cloud')).toBe(128_000)
    expect(contextLimitFor('gpt-oss:20b-cloud')).toBe(128_000)
    expect(contextLimitFor('gemma4:cloud')).toBe(256_000)
    expect(contextLimitFor('nemotron-3-super:cloud')).toBe(256_000)
    expect(contextLimitFor('muse-glimmer:cloud')).toBe(128_000)
  })

  it('GPT-5.6 Luna/Terra/Sol usam a janela oficial de 1,05M', () => {
    expect(contextLimitFor('gpt-5.6-luna')).toBe(1_050_000)
    expect(contextLimitFor('gpt-5.6-terra')).toBe(1_050_000)
    expect(contextLimitFor('gpt-5.6-sol')).toBe(1_050_000)
  })

  it('modelo desconhecido cai no fallback padrão', () => {
    expect(contextLimitFor('modelo-inexistente')).toBe(200_000)
    expect(contextLimitFor(undefined)).toBe(200_000)
  })

  it('todo modelo do CONTEXT_LIMITS tem um valor positivo', () => {
    for (const [model, limit] of Object.entries(CONTEXT_LIMITS)) {
      expect(limit, model).toBeGreaterThan(0)
    }
  })
})

describe('modelSupportsVision — quais modelos aceitam imagem direto', () => {
  it('Claude sempre suporta (mesmo modelo desconhecido/futuro)', () => {
    expect(modelSupportsVision('claude-opus-4-8')).toBe(true)
    expect(modelSupportsVision('claude-sonnet-5')).toBe(true)
    expect(modelSupportsVision(undefined)).toBe(true)
  })

  it('GPT-5.6 mantém imagem nativa pelo tradutor Responses', () => {
    expect(modelSupportsVision('gpt-5.6-luna')).toBe(true)
    expect(modelSupportsVision('gpt-5.6-terra')).toBe(true)
    expect(modelSupportsVision('gpt-5.6-sol')).toBe(true)
  })

  it('Kimi K3 aceita imagem direto (multimodal nativo, herdou o slot do K2.7)', () => {
    expect(modelSupportsVision('kimi-k3:cloud')).toBe(true)
  })

  it('demais modelos Ollama são texto-only (400 real da API) — precisam do vision relay', () => {
    expect(modelSupportsVision('nemotron-3-ultra:cloud')).toBe(false)
    expect(modelSupportsVision('gpt-oss:120b-cloud')).toBe(false)
    expect(modelSupportsVision('gpt-oss:20b-cloud')).toBe(false)
    expect(modelSupportsVision('gemma4:cloud')).toBe(false)
    expect(modelSupportsVision('nemotron-3-super:cloud')).toBe(false)
    expect(modelSupportsVision('muse-glimmer:cloud')).toBe(false)
    expect(modelSupportsVision('glm-5.2:cloud')).toBe(false)
  })
})

describe('modelSupportsFastMode — quais modelos aceitam o modo rápido', () => {
  it('só os Opus suportados pela Anthropic (Opus 5 e 4.8)', () => {
    expect(modelSupportsFastMode('claude-opus-5')).toBe(true)
    expect(modelSupportsFastMode('claude-opus-4-8')).toBe(true)
  })

  it('Opus 4.7 NÃO entra — o modo rápido dele foi removido em 24/07/2026 e a API rejeita', () => {
    expect(modelSupportsFastMode('claude-opus-4-7')).toBe(false)
  })

  it('Sonnet/Haiku/Fable, Ollama e desconhecidos ficam de fora (a API rejeitaria)', () => {
    expect(modelSupportsFastMode('claude-sonnet-5')).toBe(false)
    expect(modelSupportsFastMode('claude-haiku-4-5')).toBe(false)
    expect(modelSupportsFastMode('claude-fable-5-1')).toBe(false)
    expect(modelSupportsFastMode('claude-fable-5')).toBe(false)
    expect(modelSupportsFastMode('nemotron-3-ultra:cloud')).toBe(false)
    expect(modelSupportsFastMode('muse-glimmer:cloud')).toBe(false)
    expect(modelSupportsFastMode('modelo-inexistente')).toBe(false)
    expect(modelSupportsFastMode(undefined)).toBe(false)
  })
})

describe('MODEL_EFFORT — esforço máximo do SDK', () => {
  it('expõe max para Opus/Sonnet/Fable e mantém Haiku limitado a high', () => {
    expect(MODEL_EFFORT['claude-opus-4-8']).toContain('max')
    expect(MODEL_EFFORT['claude-sonnet-5']).toContain('max')
    expect(MODEL_EFFORT['claude-fable-5-1']).toContain('max')
    expect(MODEL_EFFORT['claude-fable-5']).toContain('max')
    expect(MODEL_EFFORT['claude-haiku-4-5']).toEqual(['low', 'medium', 'high'])
  })

  it('oferece low até max para toda a família GPT-5.6', () => {
    const expected = ['low', 'medium', 'high', 'xhigh', 'max']
    expect(MODEL_EFFORT['gpt-5.6-luna']).toEqual(expected)
    expect(MODEL_EFFORT['gpt-5.6-terra']).toEqual(expected)
    expect(MODEL_EFFORT['gpt-5.6-sol']).toEqual(expected)
  })
})
