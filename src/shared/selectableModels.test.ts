import { describe, expect, it } from 'vitest'
import { CLAUDE_MODELS, OLLAMA_MODELS, OPENAI_MODELS } from './ipc'
import { ollamaSelectable, selectableModelIds } from './selectableModels'

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
})
