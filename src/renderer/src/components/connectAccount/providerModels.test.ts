import { describe, expect, it } from 'vitest'
import { CLAUDE_MODELS, DEEPSEEK_MODELS, OLLAMA_MODELS, OPENAI_MODELS } from '@shared/ipc'
import { hasAnyProvider, modelAfterConnect, modelForNewConversation, providerOfModel } from './providerModels'

const NONE = { claude: false, gpt: false, ollama: false, deepseek: false }
const CLAUDE = CLAUDE_MODELS[0].id
const GPT = OPENAI_MODELS[0].id
const OLLAMA = OLLAMA_MODELS[0].id
const DEEPSEEK = DEEPSEEK_MODELS[0].id

describe('providerModels', () => {
  it('hasAnyProvider', () => {
    expect(hasAnyProvider(NONE)).toBe(false)
    expect(hasAnyProvider({ ...NONE, ollama: true })).toBe(true)
    expect(hasAnyProvider({ ...NONE, deepseek: true })).toBe(true)
  })

  it('providerOfModel', () => {
    expect(providerOfModel(CLAUDE)).toBe('claude')
    expect(providerOfModel(GPT)).toBe('gpt')
    expect(providerOfModel(OLLAMA)).toBe('ollama')
    expect(providerOfModel(DEEPSEEK)).toBe('deepseek')
    // O DeepSeek do Ollama continua sendo Ollama.
    expect(providerOfModel('deepseek-v4-pro:cloud')).toBe('ollama')
    expect(providerOfModel('auto')).toBe('claude')
  })

  it('modelo de provedor desconectado passa para o primeiro do recém-conectado', () => {
    expect(modelAfterConnect(CLAUDE, { ...NONE, gpt: true }, 'gpt')).toBe(GPT)
    expect(modelAfterConnect(GPT, { ...NONE, ollama: true }, 'ollama')).toBe(OLLAMA)
    expect(modelAfterConnect(CLAUDE, { ...NONE, deepseek: true }, 'deepseek')).toBe(DEEPSEEK)
  })

  it('modelo do provedor conectado fica como está', () => {
    expect(modelAfterConnect(CLAUDE_MODELS[1].id, { ...NONE, claude: true }, 'claude')).toBe(CLAUDE_MODELS[1].id)
    expect(modelAfterConnect(GPT, { ...NONE, gpt: true, ollama: true }, 'ollama')).toBe(GPT)
  })

  it('conversa nova segue a mesma regra', () => {
    expect(modelForNewConversation(CLAUDE, { ...NONE, gpt: true })).toBe(GPT)
    expect(modelForNewConversation(CLAUDE, { ...NONE, claude: true })).toBe(CLAUDE)
    expect(modelForNewConversation(CLAUDE, { ...NONE, deepseek: true })).toBe(DEEPSEEK)
    expect(modelForNewConversation(DEEPSEEK, { ...NONE, claude: true })).toBe(CLAUDE)
    expect(modelForNewConversation(CLAUDE, NONE)).toBe(CLAUDE)
    expect(modelForNewConversation(CLAUDE, null)).toBe(CLAUDE)
  })

  it('Kimi: provedor próprio, K3.1 Pro como primeiro, antes de Ollama/DeepSeek na conversa nova', () => {
    expect(providerOfModel('k3.1-pro')).toBe('kimi')
    expect(providerOfModel('k3.1-pro-highspeed')).toBe('kimi')
    // O Kimi do Ollama continua sendo Ollama.
    expect(providerOfModel('kimi-k3:cloud')).toBe('ollama')
    expect(modelAfterConnect(CLAUDE, { ...NONE, kimi: true }, 'kimi')).toBe('k3.1-pro')
    expect(modelForNewConversation(CLAUDE, { ...NONE, kimi: true, ollama: true, deepseek: true })).toBe('k3.1-pro')
    expect(hasAnyProvider({ ...NONE, kimi: true })).toBe(true)
  })
})
