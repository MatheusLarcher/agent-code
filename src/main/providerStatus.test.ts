import { describe, expect, it } from 'vitest'
import { providerStatusWith } from './providerStatus'

const yes = async (): Promise<boolean> => true
const no = async (): Promise<boolean> => false
const boom = async (): Promise<boolean> => {
  throw new Error('falhou')
}

describe('providerStatusWith', () => {
  it('combina os três provedores', async () => {
    expect(await providerStatusWith({ claude: yes, gpt: no, ollama: () => true })).toEqual({
      claude: true,
      gpt: false,
      ollama: true
    })
    expect(await providerStatusWith({ claude: no, gpt: no, ollama: () => false })).toEqual({
      claude: false,
      gpt: false,
      ollama: false
    })
    expect(await providerStatusWith({ claude: no, gpt: yes, ollama: () => false })).toEqual({
      claude: false,
      gpt: true,
      ollama: false
    })
  })

  it('consulta que falha conta como false e não derruba as outras', async () => {
    const ollamaThrows = (): boolean => {
      throw new Error('config')
    }
    expect(await providerStatusWith({ claude: boom, gpt: yes, ollama: ollamaThrows })).toEqual({
      claude: false,
      gpt: true,
      ollama: false
    })
  })
})
