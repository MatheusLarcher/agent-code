import { describe, expect, it } from 'vitest'
import { escapeHtml, highlightToLines, LineHighlighter, splitHighlighted } from './highlightLines'

describe('highlightLines', () => {
  it('escapa o texto puro', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })

  it('divide o HTML por linha reabrindo os spans abertos (comentário de várias linhas)', () => {
    const html = '<span class="hljs-comment">/* a\n * b */</span>\n<span class="hljs-keyword">const</span> x'
    expect(splitHighlighted(html)).toEqual([
      '<span class="hljs-comment">/* a</span>',
      '<span class="hljs-comment"> * b */</span>',
      '<span class="hljs-keyword">const</span> x'
    ])
  })

  it('spans aninhados atravessando a quebra (template string com ${} e JSX)', () => {
    const html = '<span class="hljs-string">`a <span class="hljs-subst">${x}</span>\nb`</span>\n<span class="language-xml"><span class="hljs-tag">&lt;b&gt;</span>\nx</span>'
    expect(splitHighlighted(html)).toEqual([
      '<span class="hljs-string">`a <span class="hljs-subst">${x}</span></span>',
      '<span class="hljs-string">b`</span>',
      '<span class="language-xml"><span class="hljs-tag">&lt;b&gt;</span></span>',
      '<span class="language-xml">x</span>'
    ])
  })

  it('com o hljs de verdade: a string de várias linhas fica realçada nas duas linhas', () => {
    const lines = highlightToLines('const s = `a\nb`\nlet y = 2', 'typescript')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe('<span class="hljs-string">b`</span>')
    expect(lines[2]).toContain('<span class="hljs-keyword">let</span>')
  })

  it('sem linguagem conhecida: só escapa; o número de linhas é sempre o do texto', () => {
    expect(highlightToLines('<x>\n\n', '')).toEqual(['&lt;x&gt;', '', ''])
    expect(highlightToLines('a\n', 'typescript')).toHaveLength(2)
    expect(highlightToLines('', 'typescript')).toEqual([''])
  })

  it('código nunca vira HTML: o realce escapa tags e aspas', () => {
    const [line] = highlightToLines('const t = "<img src=x onerror=alert(1)>"', 'typescript')
    expect(line).not.toContain('<img')
    expect(line).toContain('&lt;img')
  })

  it('LineHighlighter: texto que cresce dá o mesmo realce do completo, refazendo só o fim', () => {
    const unit = (i: number): string =>
      `/** Item ${i}\n * com comentário */\nexport function item${i}(a: number): string {\n  const s = \`v\${a}\n${i}\`\n  return s // ok\n}\n`
    const full = Array.from({ length: 120 }, (_, i) => unit(i)).join('')
    const hl = new LineHighlighter()
    for (const cut of [600, 9000, 13000, 13001, 17000, full.length]) {
      const text = full.slice(0, cut)
      expect(hl.lines(text, 'typescript'), `corte ${cut}`).toEqual(highlightToLines(text, 'typescript'))
    }
    expect(hl.lines(full, 'typescript')).toBe(hl.lines(full, 'typescript'))
  })
})
