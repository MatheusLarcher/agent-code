import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PickElementResult } from '@shared/ipc'
import { PICK_HINT, PickElementButton } from './PickElementButton'

const notify = vi.fn()
vi.mock('../../ui/UiProvider', () => ({ useUI: () => ({ notify }) }))

afterEach(() => {
  cleanup()
  notify.mockReset()
})

/** Monta o botão com uma seleção que o teste resolve quando quiser. */
function mount() {
  let settle: (r: PickElementResult) => void = () => {}
  const pickElement = vi.fn(() => new Promise<PickElementResult>((r) => (settle = r)))
  render(<PickElementButton api={{ pickElement }} />)
  const button = screen.getByRole('button', { name: 'Selecionar' }) as HTMLButtonElement
  const finish = (r: PickElementResult) => act(async () => settle(r))
  return { pickElement, button, finish }
}

describe('botão Selecionar do composer', () => {
  it('um clique pede UM elemento ao Chrome, diz onde clicar e trava até o desfecho', async () => {
    const { pickElement, button, finish } = mount()
    expect(button.getAttribute('data-tip')).toBe('Selecionar um elemento de uma página do seu Chrome')
    expect(button.hasAttribute('title')).toBe(false)
    fireEvent.click(button)
    expect(pickElement).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('aviso', PICK_HINT)
    expect(button.disabled).toBe(true)
    expect(button.className).toContain('active')
    fireEvent.click(button) // selecionando: o segundo clique não abre outra seleção
    expect(pickElement).toHaveBeenCalledTimes(1)

    await finish({ status: 'picked' })
    expect(button.disabled).toBe(false)
    expect(notify).toHaveBeenCalledTimes(1) // escolhido: o bloco no campo já diz tudo
  })

  it('Esc cancela sem erro', async () => {
    const { button, finish } = mount()
    fireEvent.click(button)
    await finish({ status: 'canceled' })
    expect(notify.mock.calls.map((c) => c[0])).toEqual(['aviso'])
    expect(button.disabled).toBe(false)
  })

  it('extensão desconectada: toast de erro pedindo para instalar ou ativar em Configurações', async () => {
    const { button, finish } = mount()
    fireEvent.click(button)
    await finish({ status: 'not-connected', message: 'Instale ou ative a extensão do Chrome em Configurações' })
    expect(notify).toHaveBeenLastCalledWith('erro', 'Instale ou ative a extensão do Chrome em Configurações')
  })

  it('a página navegar no meio encerra com toast de aviso', async () => {
    const { button, finish } = mount()
    fireEvent.click(button)
    await finish({ status: 'navigated', message: 'A página mudou durante a seleção. Clique em Selecionar de novo.' })
    expect(notify).toHaveBeenLastCalledWith('aviso', 'A página mudou durante a seleção. Clique em Selecionar de novo.')
  })

  it('campo travado desliga o botão; app sem a função avisa em vez de quebrar', () => {
    const { rerender } = render(<PickElementButton disabled api={{ pickElement: vi.fn() }} />)
    expect((screen.getByRole('button', { name: 'Selecionar' }) as HTMLButtonElement).disabled).toBe(true)
    rerender(<PickElementButton api={{} as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar' }))
    expect(notify).toHaveBeenCalledWith('erro', 'Seleção de elemento indisponível nesta versão do app.')
  })
})
