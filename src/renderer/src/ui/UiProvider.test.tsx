import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UiProvider, useUI, type NotifyOptions, type ToastType } from './UiProvider'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** Botão que dispara o toast pedido — o jeito de chegar ao notify de dentro do provider. */
function Trigger({ tipo, msg, opts }: { tipo: ToastType; msg: string; opts?: NotifyOptions }): JSX.Element {
  const { notify } = useUI()
  return <button onClick={() => (opts ? notify(tipo, msg, opts) : notify(tipo, msg))}>disparar</button>
}

function mount(tipo: ToastType, msg: string, opts?: NotifyOptions): void {
  render(
    <UiProvider>
      <Trigger tipo={tipo} msg={msg} opts={opts} />
    </UiProvider>
  )
  fireEvent.click(screen.getByText('disparar'))
}

/** O toast sai com um fade de 280 ms antes de deixar o DOM. */
function finishFade(): void {
  act(() => {
    vi.advanceTimersByTime(300)
  })
}

describe('UiProvider — toasts', () => {
  it('chamada antiga (sem opts): mostra, fecha no clique e não precisa de ação', () => {
    vi.useFakeTimers()
    mount('sucesso', 'Conversa excluída.')
    const toast = screen.getByRole('status')
    expect(toast.textContent).toContain('Conversa excluída.')
    expect(toast.className).toContain('sucesso')
    fireEvent.click(toast)
    expect(toast.className).toContain('leaving')
    finishFade()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('com onClick: o clique no corpo executa a ação UMA vez e fecha', () => {
    vi.useFakeTimers()
    const onClick = vi.fn()
    mount('aviso', 'Entrega atrasada: Tela', { onClick })
    const toast = screen.getByRole('status')
    fireEvent.click(toast)
    fireEvent.click(toast)
    expect(onClick).toHaveBeenCalledTimes(1)
    finishFade()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('o X só fecha: não executa a ação', () => {
    vi.useFakeTimers()
    const onClick = vi.fn()
    mount('aviso', 'Envio parado', { onClick })
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))
    finishFade()
    expect(onClick).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('some sozinho em ~4,5 s, sem executar a ação; vários se empilham', () => {
    vi.useFakeTimers()
    const onClick = vi.fn()
    mount('sucesso', 'Envio concluído', { onClick })
    fireEvent.click(screen.getByText('disparar'))
    expect(screen.getAllByRole('status')).toHaveLength(2)
    act(() => {
      vi.advanceTimersByTime(4400)
    })
    expect(screen.getAllByRole('status')).toHaveLength(2)
    act(() => {
      vi.advanceTimersByTime(400)
    })
    finishFade()
    expect(screen.queryByRole('status')).toBeNull()
    expect(onClick).not.toHaveBeenCalled()
  })
})
