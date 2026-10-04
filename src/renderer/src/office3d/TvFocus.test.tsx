import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TvFocusInfo } from './projectors'
import { TvFocus } from './TvFocus'

const mockup: TvFocusInfo = { kind: 'mockup', roomId: 'office', convId: 'c1', agent: 'Loja', cwd: 'C:\\p', path: 'C:\\p\\m\\tela.html', rel: 'm/tela.html', callId: 'call-1', waiting: 1 }
const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  })
}

describe('o foco dentro da TV (TvFocus)', () => {
  it('mockup: iframe isolado (só scripts) pelo protocolo; "+1 esperando"; Aprovar manda "Aprovado: <arquivo>"', async () => {
    const send = vi.fn()
    const url = vi.fn(async () => ({ ok: true as const, url: 'agent-mockup://t/m/tela.html' }))
    render(<TvFocus info={mockup} projectors={{ mirror: vi.fn() }} onClose={vi.fn()} onSend={send} mockupUrl={url} />)
    await flush()
    expect(url).toHaveBeenCalledWith({ cwd: 'C:\\p', path: 'C:\\p\\m\\tela.html' })
    const frame = screen.getByTestId('tv-focus-iframe')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('src')).toBe('agent-mockup://t/m/tela.html')
    expect(screen.getByText('+1 esperando')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Aprovar' }))
    expect(send).toHaveBeenCalledWith('c1', 'Aprovado: m/tela.html')
  })

  it('Pedir ajuste: o texto vai como "Ajustes no <arquivo>: <texto>"; vazio não manda; o arquivo que sumiu mostra o motivo', async () => {
    const send = vi.fn()
    const view = render(<TvFocus info={mockup} projectors={{ mirror: vi.fn() }} onClose={vi.fn()} onSend={send} mockupUrl={async () => ({ ok: true, url: 'agent-mockup://t/x' })} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Pedir ajuste' }))
    expect((screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Ajustes'), { target: { value: ' botão maior ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    expect(send).toHaveBeenCalledWith('c1', 'Ajustes no m/tela.html: botão maior')
    view.unmount()
    render(<TvFocus info={mockup} projectors={{ mirror: vi.fn() }} onClose={vi.fn()} mockupUrl={async () => ({ ok: false, error: 'o arquivo não existe dentro da pasta da conversa' })} />)
    await flush()
    expect(screen.getByText(/Não deu para abrir m\/tela.html/)).toBeTruthy()
    expect(screen.queryByTestId('tv-focus-reply')).toBeNull() // sem onSend, sem faixa
  })

  it('teste ao vivo e placar: o espelho da TV (canvas) liga na montagem e solta ao fechar; × fecha', () => {
    const mirror = vi.fn()
    const close = vi.fn()
    const v = render(<TvFocus info={{ kind: 'test', roomId: 'office', convId: 'c2', agent: 'Portal', url: 'http://x', title: 'Login', waiting: 0 }} projectors={{ mirror }} onClose={close} />)
    const canvas = screen.getByTestId('tv-focus-mirror')
    expect(mirror).toHaveBeenLastCalledWith('office', canvas)
    expect(screen.queryByText(/esperando/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Fechar a TV' }))
    expect(close).toHaveBeenCalled()
    v.unmount()
    expect(mirror).toHaveBeenLastCalledWith('office', null)
    render(<TvFocus info={{ kind: 'score', roomId: 'office', waiting: 0 }} projectors={{ mirror }} onClose={close} />)
    expect(screen.getByText('Placar do escritório')).toBeTruthy()
  })
})
