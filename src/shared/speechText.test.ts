import { describe, it, expect } from 'vitest'
import { splitForSpeech, toSpeechText } from './speechText'

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

describe('splitForSpeech — fatiar para tocar rápido', () => {
  it('texto curto vira um único pedaço', () => {
    expect(splitForSpeech('Oi, tudo bem?')).toEqual(['Oi, tudo bem?'])
  })

  it('vazio → nenhum pedaço', () => {
    expect(splitForSpeech('')).toEqual([])
  })

  it('o primeiro pedaço é bem pequeno (1ª frase) — baixa latência até o 1º áudio', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Frase número ${i}.`).join(' ')
    const chunks = splitForSpeech(long)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].length).toBeLessThanOrEqual(60)
    // e o primeiro pedaço sai antes (mais curto) que os seguintes, que crescem
    expect(chunks[0].length).toBeLessThanOrEqual(chunks[chunks.length - 1].length)
  })

  it('os pedaços crescem em rampa (primeiro menor que os do meio/fim)', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Esta é a frase de número ${i} aqui.`).join(' ')
    const chunks = splitForSpeech(long)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    expect(chunks[0].length).toBeLessThan(chunks[2].length)
  })

  it('quebra uma frase gigante sem deixar nenhum pedaço enorme', () => {
    const huge = `Começo, ${'palavra '.repeat(120)}fim.`
    const chunks = splitForSpeech(huge)
    expect(chunks.every((c) => c.length <= 260)).toBe(true)
  })

  it('preserva todo o conteúdo (nada é perdido ao fatiar)', () => {
    const txt = 'Primeira frase. Segunda frase um pouco maior. Terceira.'
    const joined = splitForSpeech(txt).join(' ')
    for (const w of ['Primeira', 'Segunda', 'Terceira']) expect(joined).toContain(w)
  })
})
