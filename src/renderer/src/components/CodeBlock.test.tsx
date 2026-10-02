import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { CodeBlock, extToLang, highlightCode } from './CodeBlock'

describe('CodeBlock', () => {
  it('extToLang mapeia as extensões, inclusive C# e SQL; sem extensão conhecida, vazio', () => {
    expect(extToLang('C:\\p\\Cart.tsx')).toBe('typescript')
    expect(extToLang('src/main.MJS')).toBe('javascript')
    expect(extToLang('Api\\Program.cs')).toBe('csharp')
    expect(extToLang('db/schema.sql')).toBe('sql')
    expect(extToLang('LEIAME')).toBe('')
  })

  it('highlightCode devolve o HTML do hljs, com o código escapado', () => {
    const html = highlightCode('const a = "<b>"', 'typescript')
    expect(html).toContain('<span class="hljs-keyword">const</span>')
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>')
  })

  it('C# e SQL realçam', () => {
    expect(highlightCode('public class Pedido { }', 'csharp')).toContain('<span class="hljs-keyword">public</span>')
    expect(highlightCode('SELECT id FROM pedidos', 'sql')).toContain('<span class="hljs-keyword">SELECT</span>')
  })

  it('o bloco continua igual: pre.code-block.hljs com o HTML realçado', () => {
    const { container } = render(<CodeBlock code="let x = 1" language="javascript" />)
    expect(container.querySelector('pre.code-block.hljs code .hljs-keyword')?.textContent).toBe('let')
  })
})
