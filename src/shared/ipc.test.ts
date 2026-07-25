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
    expect(contextLimitFor('claude-fable-5')).toBe(1_000_000)
    expect(contextLimitFor('claude-haiku-4-5')).toBe(200_000)
  })

  it('Ollama Cloud: DeepSeek V4 Pro e GLM-5.2 são 1M nativos (não 128K/200K)', () => {
    expect(contextLimitFor('deepseek-v4-pro:cloud')).toBe(1_000_000)
    expect(contextLimitFor('glm-5.2:cloud')).toBe(1_000_000)
  })

  it('Ollama Cloud: Qwen3-Coder 256K, gpt-oss 128K, Kimi K2.7 256K', () => {
    expect(contextLimitFor('qwen3-coder:480b-cloud')).toBe(256_000)
    expect(contextLimitFor('gpt-oss:120b-cloud')).toBe(128_000)
    expect(contextLimitFor('gpt-oss:20b-cloud')).toBe(128_000)
    expect(contextLimitFor('kimi-k2.7-code:cloud')).toBe(256_000)
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

  it('Kimi K2.7 Code aceita imagem direto (verificado com probe real contra a API do Ollama Cloud)', () => {
    expect(modelSupportsVision('kimi-k2.7-code:cloud')).toBe(true)
  })

  it('demais modelos Ollama são texto-only (400 real da API) — precisam do vision relay', () => {
    expect(modelSupportsVision('qwen3-coder:480b-cloud')).toBe(false)
    expect(modelSupportsVision('gpt-oss:120b-cloud')).toBe(false)
    expect(modelSupportsVision('gpt-oss:20b-cloud')).toBe(false)
    expect(modelSupportsVision('deepseek-v4-pro:cloud')).toBe(false)
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
    expect(modelSupportsFastMode('claude-fable-5')).toBe(false)
    expect(modelSupportsFastMode('qwen3-coder:480b-cloud')).toBe(false)
    expect(modelSupportsFastMode('modelo-inexistente')).toBe(false)
    expect(modelSupportsFastMode(undefined)).toBe(false)
  })
})

describe('MODEL_EFFORT — esforço máximo do SDK', () => {
  it('expõe max para Opus/Sonnet/Fable e mantém Haiku limitado a high', () => {
    expect(MODEL_EFFORT['claude-opus-4-8']).toContain('max')
    expect(MODEL_EFFORT['claude-sonnet-5']).toContain('max')
    expect(MODEL_EFFORT['claude-fable-5']).toContain('max')
    expect(MODEL_EFFORT['claude-haiku-4-5']).toEqual(['low', 'medium', 'high'])
  })
})
