import { describe, it, expect } from 'vitest'
import { contextLimitFor, modelSupportsVision, CONTEXT_LIMITS } from './ipc'

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
