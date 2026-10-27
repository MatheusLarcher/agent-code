import { describe, expect, it } from 'vitest'
import { providerStatusWith } from './providerStatus'

const yes = async (): Promise<boolean> => true
const no = async (): Promise<boolean> => false
const boom = async (): Promise<boolean> => {
  throw new Error('falhou')
}

describe('providerStatusWith', () => {
  it('combina os quatro provedores', async () => {
    expect(await providerStatusWith({ claude: yes, gpt: no, ollama: () => true, deepseek: () => false })).toEqual({
      claude: true,
      gpt: false,
      ollama: true,
      deepseek: false,
      kimi: false
    })
    expect(await providerStatusWith({ claude: no, gpt: no, ollama: () => false, deepseek: () => false })).toEqual({
      claude: false,
      gpt: false,
      ollama: false,
      deepseek: false,
      kimi: false
    })
    expect(await providerStatusWith({ claude: no, gpt: yes, ollama: () => false, deepseek: () => false })).toEqual({
      claude: false,
      gpt: true,
      ollama: false,
      deepseek: false,
      kimi: false
    })
  })

  it('DeepSeek ligado + chave conta como conectado sozinho', async () => {
    expect(await providerStatusWith({ claude: no, gpt: no, ollama: () => false, deepseek: () => true })).toEqual({
      claude: false,
      gpt: false,
      ollama: false,
      deepseek: true,
      kimi: false
    })
  })

  it('consulta que falha conta como false e não derruba as outras', async () => {
    const ollamaThrows = (): boolean => {
      throw new Error('config')
    }
    expect(await providerStatusWith({ claude: boom, gpt: yes, ollama: ollamaThrows, deepseek: ollamaThrows })).toEqual({
      claude: false,
      gpt: true,
      ollama: false,
      deepseek: false,
      kimi: false
    })
  })

  it('Kimi conectado (ligado + chave + teste) entra no status; consulta que falha conta false', async () => {
    const base = { claude: no, gpt: no, ollama: () => false, deepseek: () => false }
    expect((await providerStatusWith({ ...base, kimi: () => true })).kimi).toBe(true)
    expect((await providerStatusWith({ ...base, kimi: boom })).kimi).toBe(false)
  })
})
