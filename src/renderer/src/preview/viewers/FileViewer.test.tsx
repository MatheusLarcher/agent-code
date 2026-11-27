import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { PreviewFileOk } from '@shared/preview'
import { FileViewer } from './FileViewer'
import { CODE_HIGHLIGHT_MAX, codeHtml, CodeView } from './CodeView'

afterEach(cleanup)

describe('FileViewer', () => {
  it('markdown usa o Markdown do chat', () => {
    const { container } = render(
      <FileViewer result={{ ok: true, kind: 'markdown', path: 'C:/a/LEIA.md', text: '# Título\n\ntexto', truncated: false }} />
    )
    expect(container.querySelector('.pv-md .md h1')?.textContent).toBe('Título')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('markdown cortado mostra aviso', () => {
    render(<FileViewer result={{ ok: true, kind: 'markdown', path: 'a.md', text: 'oi', truncated: true }} />)
    expect(screen.getByRole('status').textContent).toContain('2 MB')
  })

  it('planilha vira tabela', () => {
    const { container } = render(
      <FileViewer result={{ ok: true, kind: 'table', path: 'a.csv', sheets: [{ name: 'a', rows: [['x'], ['1']], truncated: false }] }} />
    )
    expect(container.querySelector('table.pv-grid')).not.toBeNull()
  })

  it('json vai para o JsonView; .jsonl lê uma linha por valor', () => {
    const { container } = render(
      <FileViewer result={{ ok: true, kind: 'json', path: 'C:/x/log.jsonl', text: '{"a":1}\n{"a":2}', truncated: false }} />
    )
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2)
  })

  it('código ganha realce pela extensão; texto fica puro', () => {
    const { container } = render(
      <FileViewer result={{ ok: true, kind: 'code', path: 'src/a.ts', text: 'const a = 1\nlet b = 2\n', truncated: false }} />
    )
    const code = container.querySelector('.pv-code')
    expect(code?.getAttribute('data-highlighted')).toBe('true')
    expect(container.querySelector('.hljs-keyword')).not.toBeNull()
    // A quebra final não vira linha numerada.
    expect(container.querySelector('.pv-code-gutter')?.textContent).toBe('1\n2')
    cleanup()

    const t = render(<FileViewer result={{ ok: true, kind: 'text', path: 'a.log', text: 'const <b>', truncated: false }} />)
    expect(t.container.querySelector('.pv-code')?.getAttribute('data-highlighted')).toBe('false')
    expect(t.container.querySelector('.pv-code-text')?.innerHTML).toContain('const &lt;b&gt;')
  })

  it('html e mídia ficam com o host (null)', () => {
    const html: PreviewFileOk = { ok: true, kind: 'html', path: 'a.html', url: 'agent-preview://file/a' }
    const media: PreviewFileOk = { ok: true, kind: 'media', path: 'a.png', url: 'agent-preview://file/b' }
    expect(render(<FileViewer result={html} />).container.innerHTML).toBe('')
    expect(render(<FileViewer result={media} />).container.innerHTML).toBe('')
  })
})

describe('CodeView', () => {
  it('arquivo grande demais vai sem realce, com aviso', () => {
    const big = 'x'.repeat(CODE_HIGHLIGHT_MAX + 1)
    expect(codeHtml(big, 'typescript', false).highlighted).toBe(false)
    render(<CodeView text={big} lang="typescript" />)
    expect(screen.getByRole('status').textContent).toContain('sem cores')
  })

  it('cortado avisa os 2 MB', () => {
    render(<CodeView text="a" lang="typescript" truncated />)
    expect(screen.getByRole('status').textContent).toBe('Arquivo grande: mostrando só os primeiros 2 MB.')
  })

  it('escapa HTML no texto puro', () => {
    expect(codeHtml('<script>&', undefined, true)).toEqual({ html: '&lt;script&gt;&amp;', highlighted: false })
  })
})
