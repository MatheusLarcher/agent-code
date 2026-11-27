import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UiProvider } from './UiProvider'
import { VaultPassphraseField } from './VaultPassphraseField'

afterEach(cleanup)

function api(status: { set: boolean; cloud: boolean; pendingRestore: boolean }, result: { ok: boolean; error?: string } = { ok: true }) {
  const set = vi.fn(async () => result)
  ;(window as unknown as { api: unknown }).api = { vaultPassphraseStatus: vi.fn(async () => status), setVaultPassphrase: set }
  return set
}

describe('VaultPassphraseField', () => {
  it('na nuvem sem frase: explica e só libera o botão com 12+ caracteres', async () => {
    const set = api({ set: false, cloud: true, pendingRestore: false })
    render(<UiProvider><VaultPassphraseField /></UiProvider>)
    await screen.findByText(/só fica neste computador até você criar uma frase-senha/)
    const button = screen.getByRole('button', { name: 'Salvar frase-senha' }) as HTMLButtonElement
    fireEvent.change(screen.getByLabelText('Frase-senha do cofre'), { target: { value: 'curta' } })
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Frase-senha do cofre'), { target: { value: 'uma frase bem comprida' } })
    fireEvent.click(button)
    await waitFor(() => expect(set).toHaveBeenCalledWith('uma frase bem comprida'))
  })

  it('cofre da nuvem esperando a frase: pede para abrir e mostra o erro da frase errada', async () => {
    api({ set: false, cloud: true, pendingRestore: true }, { ok: false, error: 'Essa frase-senha não abre o cofre que está na nuvem.' })
    render(<UiProvider><VaultPassphraseField /></UiProvider>)
    fireEvent.change(await screen.findByLabelText('Frase-senha do cofre'), { target: { value: 'frase errada longa' } })
    fireEvent.click(screen.getByRole('button', { name: 'Abrir o cofre' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/não abre o cofre/)
  })
})
