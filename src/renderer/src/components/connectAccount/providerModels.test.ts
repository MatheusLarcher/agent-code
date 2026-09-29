import { describe, expect, it } from 'vitest'
import { CLAUDE_MODELS, OLLAMA_MODELS, OPENAI_MODELS } from '@shared/ipc'
import { hasAnyProvider, modelAfterConnect, modelForNewConversation, providerOfModel } from './providerModels'

const NONE = { claude: false, gpt: false, ollama: false }
const CLAUDE = CLAUDE_MODELS[0].id
const GPT = OPENAI_MODELS[0].id
const OLLAMA = OLLAMA_MODELS[0].id

describe('providerModels', () => {
  it('hasAnyProvider', () => {
    expect(hasAnyProvider(NONE)).toBe(false)
    expect(hasAnyProvider({ ...NONE, ollama: true })).toBe(true)
  })

  it('providerOfModel', () => {
    expect(providerOfModel(CLAUDE)).toBe('claude')
    expect(providerOfModel(GPT)).toBe('gpt')
    expect(providerOfModel(OLLAMA)).toBe('ollama')
    expect(providerOfModel('auto')).toBe('claude')
  })

  it('modelo de provedor desconectado passa para o primeiro do recém-conectado', () => {
    expect(modelAfterConnect(CLAUDE, { ...NONE, gpt: true }, 'gpt')).toBe(GPT)
    expect(modelAfterConnect(GPT, { ...NONE, ollama: true }, 'ollama')).toBe(OLLAMA)
  })

  it('modelo do provedor conectado fica como está', () => {
    expect(modelAfterConnect(CLAUDE_MODELS[1].id, { ...NONE, claude: true }, 'claude')).toBe(CLAUDE_MODELS[1].id)
    expect(modelAfterConnect(GPT, { ...NONE, gpt: true, ollama: true }, 'ollama')).toBe(GPT)
  })

  it('conversa nova segue a mesma regra', () => {
    expect(modelForNewConversation(CLAUDE, { ...NONE, gpt: true })).toBe(GPT)
    expect(modelForNewConversation(CLAUDE, { ...NONE, claude: true })).toBe(CLAUDE)
    expect(modelForNewConversation(CLAUDE, NONE)).toBe(CLAUDE)
    expect(modelForNewConversation(CLAUDE, null)).toBe(CLAUDE)
  })
})
