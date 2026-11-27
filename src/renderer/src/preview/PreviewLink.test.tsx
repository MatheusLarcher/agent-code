import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { PreviewProvider, type PreviewController } from './PreviewContext'
import { PreviewLink, PreviewLinkBase, previewUrlTransform } from './PreviewLink'

afterEach(cleanup)

function controller(openResult = true): { ctl: PreviewController; open: ReturnType<typeof vi.fn> } {
  const open = vi.fn(() => openResult)
  const ctl = { open: { openInPreview: open }, state: {} } as unknown as PreviewController
  return { ctl, open }
}

/** Clica e diz se o clique foi cancelado (true = não segue para o navegador). */
function click(el: HTMLElement, init: MouseEventInit = {}): boolean {
  const ev = createEvent.click(el, { button: 0, ...init })
  fireEvent(el, ev)
  return ev.defaultPrevented
}

describe('PreviewLink', () => {
  it('com o Preview: abre nele e cancela o navegador de fora', () => {
    const { ctl, open } = controller()
    render(
      <PreviewProvider controller={ctl}>
        <PreviewLink href="https://example.com">site</PreviewLink>
      </PreviewProvider>
    )
    const a = screen.getByRole('link', { name: 'site' })
    expect(a.getAttribute('target')).toBe('_blank')
    expect(click(a)).toBe(true)
    expect(open).toHaveBeenCalledWith('https://example.com')
  })

  it('alvo que o Preview recusa segue para o navegador', () => {
    const { ctl } = controller(false)
    render(
      <PreviewProvider controller={ctl}>
        <PreviewLink href="mailto:x@y.com">mail</PreviewLink>
      </PreviewProvider>
    )
    expect(click(screen.getByRole('link', { name: 'mail' }))).toBe(false)
  })

  it('Ctrl+clique e Shift+clique seguem para o navegador', () => {
    const { ctl, open } = controller()
    render(
      <PreviewProvider controller={ctl}>
        <PreviewLink href="https://example.com">site</PreviewLink>
      </PreviewProvider>
    )
    const a = screen.getByRole('link', { name: 'site' })
    expect(click(a, { ctrlKey: true })).toBe(false)
    expect(click(a, { shiftKey: true })).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('sem o Preview: link comum e o onClick de quem usa continua rodando', () => {
    const onClick = vi.fn()
    render(
      <PreviewLink href="https://example.com" onClick={onClick}>
        site
      </PreviewLink>
    )
    expect(click(screen.getByRole('link', { name: 'site' }))).toBe(false)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('previewUrlTransform', () => {
  it('mantém file: e caminho de unidade; o resto passa pelo filtro padrão', () => {
    expect(previewUrlTransform('file:///C:/a.md')).toBe('file:///C:/a.md')
    expect(previewUrlTransform('C:\\a\\b.md')).toBe('C:\\a\\b.md')
    expect(previewUrlTransform('C:/a/b.md')).toBe('C:/a/b.md')
    expect(previewUrlTransform('https://x.com')).toBe('https://x.com')
    expect(previewUrlTransform('javascript:alert(1)')).toBe('')
  })

  it('imagem (src) nunca carrega file: nem caminho de unidade (o Chromium buscaria sozinho)', () => {
    expect(previewUrlTransform('file:///C:/a.png', 'src')).toBe('')
    expect(previewUrlTransform('C:\\img\\a.png', 'src')).toBe('')
    expect(previewUrlTransform('C:/img/a.png', 'src')).toBe('')
    expect(previewUrlTransform('https://x.com/a.png', 'src')).toBe('https://x.com/a.png')
    // Link (href) local continua valendo: o clique abre no Preview.
    expect(previewUrlTransform('file:///C:/a.md', 'href')).toBe('file:///C:/a.md')
    expect(previewUrlTransform('file://localhost/C:/a.md', 'href')).toBe('file://localhost/C:/a.md')
  })

  it('endereço de outra máquina (SMB/NTLM) é recusado em link e em imagem', () => {
    for (const key of ['href', 'src'] as const) {
      expect(previewUrlTransform('file://servidor/pasta/a.png', key)).toBe('')
      expect(previewUrlTransform('file:////servidor/pasta/a.png', key)).toBe('')
      expect(previewUrlTransform('\\\\servidor\\pasta\\a.png', key)).toBe('')
      expect(previewUrlTransform('//servidor/pasta/a.png', key)).toBe('')
      expect(previewUrlTransform('file:%5C%5Cservidor%5Ca.png', key)).toBe('')
    }
    expect(previewUrlTransform('file://servidor/a.md')).toBe('')
  })
})

describe('PreviewLinkBase', () => {
  it('link dentro de um .md abre com a pasta dele como base', () => {
    const { ctl, open } = controller()
    render(
      <PreviewProvider controller={ctl}>
        <PreviewLinkBase dir="C:\docs">
          <PreviewLink href="b.md">b</PreviewLink>
        </PreviewLinkBase>
      </PreviewProvider>
    )
    expect(click(screen.getByRole('link', { name: 'b' }))).toBe(true)
    expect(open).toHaveBeenCalledWith('b.md', { base: 'C:\\docs' })
  })
})
