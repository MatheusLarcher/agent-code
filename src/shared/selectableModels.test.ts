import { describe, expect, it } from 'vitest'
import {
  CLAUDE_MODELS,
  clampEffortToModel,
  contextLimitFor,
  isDeepSeekModel,
  isNonClaudeModel,
  MODEL_EFFORT,
  modelSupportsFastMode,
  modelSupportsVision,
  OLLAMA_MODELS,
  OPENAI_MODELS,
  setKimiContextWindow
} from './ipc'
import { modelDisplayName } from './modelLabel'
import { deepseekSelectable, kimiSelectable, ollamaSelectable, selectableModelIds, selectableModels } from './selectableModels'

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

  it('Kimi: só os ids que o plano libera, com ligado + chave + conexão testada', () => {
    const cfg = { enabled: true, apiKey: 'k', region: 'intl' as const, contextWindow: 262_144, models: ['k3.1-pro'] }
    expect(kimiSelectable(cfg)).toEqual(['k3.1-pro'])
    expect(kimiSelectable({ ...cfg, enabled: false })).toEqual([])
    expect(kimiSelectable({ ...cfg, apiKey: ' ' })).toEqual([])
    expect(kimiSelectable({ ...cfg, models: [] })).toEqual([])
    expect(kimiSelectable({ ...cfg, models: ['k3.1-pro', 'modelo-estranho'] })).toEqual(['k3.1-pro'])
    expect(selectableModelIds({ ollama: false, codex: false, kimi: ['k3.1-pro'] })).toContain('k3.1-pro')
    expect(selectableModelIds({ ollama: false, codex: false, kimi: ['k3.1-pro'] })).not.toContain('k3.1-pro-highspeed')
    expect(selectableModelIds({ ollama: false, codex: false, kimi: ['k3.1-pro', 'k3.1-pro-highspeed'] })).toContain('k3.1-pro-highspeed')
    expect(selectableModelIds({ ollama: false, codex: false })).not.toContain('k3.1-pro')
  })

  it('Kimi: rótulos, 3 níveis de esforço, sem fast mode, janela detectada', () => {
    // O seletor mostra o rótulo inteiro; a tela do modelo que respondeu, sem o parêntese.
    const label = (id: string) => selectableModels({ ollama: false, codex: false, kimi: [id] }).find((m) => m.id === id)?.label
    expect(label('k3.1-pro')).toBe('Kimi K3.1 Pro (assinatura)')
    expect(label('k3.1-pro-highspeed')).toBe('Kimi K3.1 Pro Highspeed (assinatura · 2× cota)')
    expect(modelDisplayName('k3.1-pro')).toBe('Kimi K3.1 Pro')
    expect(MODEL_EFFORT['k3.1-pro']).toEqual(['low', 'high', 'max'])
    expect(clampEffortToModel('k3.1-pro', 'medium')).toBe('high')
    expect(clampEffortToModel('k3.1-pro', 'xhigh')).toBe('max')
    expect(modelSupportsFastMode('k3.1-pro')).toBe(false)
    expect(modelSupportsVision('k3.1-pro')).toBe(true)
    try {
      expect(contextLimitFor('k3.1-pro')).toBe(1_000_000)
      setKimiContextWindow(262_144)
      expect(contextLimitFor('k3.1-pro')).toBe(262_144)
      expect(contextLimitFor('k3.1-pro[1m]')).toBe(262_144)
      expect(contextLimitFor('claude-opus-5-5')).toBe(1_000_000)
    } finally {
      setKimiContextWindow(undefined)
    }
  })
})
