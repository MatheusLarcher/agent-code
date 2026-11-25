import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FeedbackDialog } from './FeedbackDialog'
import { UiProvider } from './UiProvider'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const diag = { versao: '0.1.192', sistema: 'Windows 10.0.26200 (x64)', memoriaGb: 32, gpu: 'normal', eventosTela: [] }
const carregar = (): Promise<typeof diag> => Promise.resolve(diag)

function montar(onClose = vi.fn()) {
  render(
    <UiProvider>
      <FeedbackDialog onClose={onClose} carregarDiagnostico={carregar} />
    </UiProvider>
  )
  return onClose
}

describe('FeedbackDialog', () => {
  it('sem descrição não envia e avisa', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    montar()
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pelo GitHub' }))
    expect(open).not.toHaveBeenCalled()
    expect(screen.getByText('Descreva o problema antes de enviar.')).toBeTruthy()
  })

  it('envia: abre a issue com o texto e a versão, e fecha', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } })
    const onClose = montar()
    await screen.findByText(/Versão 0\.1\.192/)
    fireEvent.click(screen.getByRole('radio', { name: 'Tenho uma ideia' }))
    fireEvent.change(screen.getByLabelText('Sua sugestão'), { target: { value: 'Fixar conversas no topo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pelo GitHub' }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    const url = new URL(open.mock.calls[0][0] as string)
    expect(url.searchParams.get('title')).toBe('[Sugestão] Fixar conversas no topo')
    expect(url.searchParams.get('body')).toContain('0.1.192')
    expect(onClose).toHaveBeenCalled()
  })

  it('Esc com o formulário vazio fecha direto', async () => {
    const onClose = montar()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})
