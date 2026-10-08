import { describe, expect, it } from 'vitest'
import { MIN_SPLIT_LENGTH, splitMarkdownBlocks } from './markdownBlocks'

const filler = (n: number): string => 'Texto de preenchimento para passar do mínimo. '.repeat(n)

describe('splitMarkdownBlocks', () => {
  it('texto curto fica inteiro; o longo corta nas linhas em branco e junta de volta igual', () => {
    expect(splitMarkdownBlocks('curto\n\noutro')).toEqual(['curto\n\noutro'])
    const text = `# Título\n\n${filler(8)}\n\n${filler(8)}\n\n| a | b |\n|---|---|\n| 1 | 2 |`
    expect(text.length).toBeGreaterThan(MIN_SPLIT_LENGTH)
    const blocks = splitMarkdownBlocks(text)
    expect(blocks.length).toBe(4)
    expect(blocks[0]).toBe('# Título')
    // Juntos de novo (com as linhas em branco das bordas), dão o mesmo texto.
    expect(blocks.join('\n\n')).toBe(text)
  })

  it('a linha em branco que chegou no fim não muda o bloco anterior (nada a reprocessar)', () => {
    const base = `${filler(14)}\n\nÚltimo parágrafo`
    expect(splitMarkdownBlocks(`${base}\n\n`)).toEqual(splitMarkdownBlocks(base))
  })

  it('nunca corta dentro de bloco de código (nem com linha em branco dentro dele)', () => {
    const code = '```ts\nconst a = 1\n\n\nconst b = 2\n```'
    const blocks = splitMarkdownBlocks(`${filler(10)}\n\n${code}\n\n${filler(4)}`)
    expect(blocks).toContain(code)
    // Bloco de código ainda aberto (streaming): tudo depois dele fica junto.
    const open = splitMarkdownBlocks(`${filler(14)}\n\n\`\`\`py\nprint(1)\n\nprint(2)`)
    expect(open[open.length - 1]).toBe('```py\nprint(1)\n\nprint(2)')
  })

  it('itens da mesma lista e continuação recuada ficam no mesmo bloco', () => {
    const list = '- primeiro\n\n- segundo\n\n  continua o segundo\n\n1. um\n2. dois'
    const blocks = splitMarkdownBlocks(`${filler(12)}\n\n${list}`)
    expect(blocks).toHaveLength(2)
    expect(blocks[1]).toBe(list)
  })

  it('com definição de link de referência, a mensagem não é dividida', () => {
    const text = `${filler(10)}\n\nVeja [aqui][doc].\n\n${filler(4)}\n\n[doc]: https://example.com`
    expect(splitMarkdownBlocks(text)).toEqual([text])
  })
})
