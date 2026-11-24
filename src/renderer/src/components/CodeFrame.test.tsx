import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Markdown } from './Markdown'
import { QuotableMessage } from './quoteComment/quoteBlocks'

const MD = 'Rode:\n\n```powershell\nnpm run build\nnpm test\n```\n\nE depois:\n\n```\nsem linguagem\n```'

function mockClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
})

describe('CodeFrame (Copiar no bloco de código)', () => {
  it('cada bloco tem a barra com a linguagem e o botão Copiar', () => {
    const { container } = render(<Markdown text={MD} />)
    const frames = container.querySelectorAll('.md-code')
    expect(frames).toHaveLength(2)
    expect(frames[0].querySelector('.md-code-lang')?.textContent).toBe('powershell')
    expect(frames[1].querySelector('.md-code-lang')?.textContent).toBe('código')
    expect(screen.getAllByRole('button', { name: 'Copiar código' })).toHaveLength(2)
  })

  it('copia o código exato do bloco (sem a quebra final) e mostra "Copiado"', async () => {
    vi.useFakeTimers()
    const writeText = mockClipboard()
    render(<Markdown text={MD} />)
    const [first] = screen.getAllByRole('button', { name: 'Copiar código' })
    await act(async () => {
      fireEvent.click(first)
    })
    expect(writeText).toHaveBeenCalledWith('npm run build\nnpm test')
    expect(first.textContent).toBe('Copiado')
    expect(first.classList.contains('done')).toBe(true)
    // A faixa da animação passa só no bloco copiado.
    const sweeps = document.querySelectorAll('.md-code-sweep')
    expect(sweeps).toHaveLength(1)
    expect(sweeps[0].closest('.md-code')).toBe(first.closest('.md-code'))
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(first.textContent).toBe('Copiar')
  })

  it('sem a API de clipboard, copia pelo caminho antigo', async () => {
    const exec = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
    render(<Markdown text={MD} />)
    const [, second] = screen.getAllByRole('button', { name: 'Copiar código' })
    await act(async () => {
      fireEvent.click(second)
    })
    expect(exec).toHaveBeenCalledWith('copy')
    expect(second.textContent).toBe('Copiado')
  })

  it('na resposta comentável (chat), o Copiar também aparece e copia', async () => {
    const writeText = mockClipboard()
    const api = { markOf: () => null, add: vi.fn() }
    const { container } = render(
      <QuotableMessage api={api} messageId="m1" source={MD}>
        <Markdown text={MD} />
      </QuotableMessage>
    )
    expect(container.querySelectorAll('.qc-pre > .md-code')).toHaveLength(2)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Copiar código' })[0])
    })
    expect(writeText).toHaveBeenCalledWith('npm run build\nnpm test')
    expect(api.add).not.toHaveBeenCalled()
  })
})
