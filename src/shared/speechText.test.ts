import { describe, it, expect } from 'vitest'
import { toSpeechText } from './speechText'

describe('toSpeechText — texto tratado para leitura', () => {
  it('remove blocos de código (não lê exemplo de código)', () => {
    const md = 'Veja este exemplo:\n\n```ts\nconst x = 1\nconsole.log(x)\n```\n\nFim.'
    const out = toSpeechText(md)
    expect(out).not.toContain('const x')
    expect(out).not.toContain('console.log')
    expect(out).toContain('Veja este exemplo')
    expect(out).toContain('Fim.')
  })

  it('mantém o texto do link mas não lê a URL', () => {
    const out = toSpeechText('Veja a [documentação](https://example.com/docs) oficial.')
    expect(out).toContain('documentação')
    expect(out).not.toContain('example.com')
    expect(out).not.toContain('https')
  })

  it('remove URLs soltas', () => {
    const out = toSpeechText('Acesse https://openai.com agora.')
    expect(out).not.toContain('openai.com')
    expect(out).toContain('Acesse')
    expect(out).toContain('agora')
  })

  it('cita a tabela em vez de lê-la', () => {
    const md = [
      'Não empata — cada um ganha em coisas diferentes:',
      '',
      '| | OpenAI | ElevenLabs |',
      '|---|---|---|',
      '| Naturalidade | Muito boa | Melhor |',
      '| Vozes | ~11 | 3.000+ |',
      '',
      'O trunfo da OpenAI é a steerability.'
    ].join('\n')
    const out = toSpeechText(md)
    expect(out).toContain('Não empata')
    expect(out).toContain('conforme a tabela')
    expect(out).not.toContain('Naturalidade')
    expect(out).not.toContain('ElevenLabs |')
    expect(out).toContain('steerability')
  })

  it('tira marcadores de título, negrito e itálico mantendo as palavras', () => {
    const out = toSpeechText('## Título\n\nIsto é **importante** e _claro_.')
    expect(out).toContain('Título')
    expect(out).toContain('importante')
    expect(out).toContain('claro')
    expect(out).not.toContain('#')
    expect(out).not.toContain('**')
    expect(out).not.toContain('_claro_')
  })

  it('remove marcadores de lista mantendo os itens', () => {
    const out = toSpeechText('- primeiro\n- segundo')
    expect(out).toContain('primeiro')
    expect(out).toContain('segundo')
    expect(out).not.toMatch(/^- /m)
  })

  it('string vazia → vazia', () => {
    expect(toSpeechText('')).toBe('')
  })
})
