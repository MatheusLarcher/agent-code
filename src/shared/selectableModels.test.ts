import { describe, expect, it } from 'vitest'
import {
  CLAUDE_MODELS,
  clampEffortToModel,
  contextLimitFor,
  isDeepSeekModel,
  isNonClaudeModel,
  MODEL_EFFORT,
  modelSupportsVision,
  OLLAMA_MODELS,
  OPENAI_MODELS
} from './ipc'
import { modelDisplayName } from './modelLabel'
import { deepseekSelectable, ollamaSelectable, selectableModelIds } from './selectableModels'

describe('selectableModels — a lista do seletor, também a do MCP de entrada', () => {
  it('Claude sempre; Ollama com integração ligada e chave; GPT com login do ChatGPT', () => {
    const ids = (list: ReadonlyArray<{ id: string }>) => list.map((m) => m.id)
    expect(selectableModelIds({ ollama: false, codex: false })).toEqual(ids(CLAUDE_MODELS))
    expect(selectableModelIds({ ollama: false, codex: true })).toEqual([...ids(CLAUDE_MODELS), ...ids(OPENAI_MODELS)])
    expect(selectableModelIds({ ollama: true, codex: true })).toEqual([...ids(CLAUDE_MODELS), ...ids(OLLAMA_MODELS), ...ids(OPENAI_MODELS)])
    expect(selectableModelIds({ ollama: false, codex: false })).not.toContain('auto')
  })

  it('Ollama só conta ligado E com chave', () => {
    expect(ollamaSelectable({ enabled: true, apiKey: ' k ' })).toBe(true)
    expect(ollamaSelectable({ enabled: true, apiKey: '  ' })).toBe(false)
    expect(ollamaSelectable({ enabled: false, apiKey: 'k' })).toBe(false)
    expect(ollamaSelectable(undefined)).toBe(false)
  })

  it('DeepSeek entra só com a flag e segue a mesma regra de ligado + chave', () => {
    expect(selectableModelIds({ ollama: false, codex: false, deepseek: true })).toContain('deepseek-flash')
    expect(selectableModelIds({ ollama: false, codex: false, deepseek: false })).not.toContain('deepseek-flash')
    expect(selectableModelIds({ ollama: true, codex: true })).not.toContain('deepseek-flash')
    expect(deepseekSelectable({ enabled: true, apiKey: ' k ' })).toBe(true)
    expect(deepseekSelectable({ enabled: true, apiKey: '' })).toBe(false)
    expect(deepseekSelectable({ enabled: false, apiKey: 'k' })).toBe(false)
  })

  it('DeepSeek: esforço recortado à escada do modelo, contexto 1M, fora da lista Claude', () => {
    expect(MODEL_EFFORT['deepseek-flash']).toEqual(['low', 'high', 'max'])
    expect(clampEffortToModel('deepseek-flash', 'xhigh')).toBe('high')
    expect(clampEffortToModel('deepseek-flash', 'medium')).toBe('low')
    expect(clampEffortToModel('deepseek-flash', 'max')).toBe('max')
    expect(contextLimitFor('deepseek-flash')).toBe(1_000_000)
    expect(CLAUDE_MODELS.map((m) => m.id)).not.toContain('deepseek-flash')
    expect(isDeepSeekModel('deepseek-flash')).toBe(true)
    expect(isDeepSeekModel('deepseek-v4-pro:cloud')).toBe(false)
    expect(isNonClaudeModel('deepseek-flash')).toBe(true)
    expect(modelSupportsVision('deepseek-flash')).toBe(true)
    expect(modelDisplayName('deepseek-flash')).toBe('DeepSeek V4.1 Flash')
  })
})
