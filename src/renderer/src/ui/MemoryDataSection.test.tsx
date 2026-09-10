import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_CONFIG, type AppConfig } from '@shared/ipc'
import { MemoryDataSection } from './MemoryDataSection'
import { UiProvider } from './UiProvider'

const SECRET_VALUE = 'sk-nunca-pode-aparecer-na-tela'

function stubApi(overrides: Partial<Record<string, unknown>> = {}): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    getConfig: vi.fn(async (): Promise<AppConfig> => ({ ...DEFAULT_CONFIG })),
    setConfig: vi.fn(async () => {}),
    listSecrets: vi.fn(async () => [
      { name: 'vps.deploy', createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-02T10:00:00.000Z' }
    ]),
    deleteSecret: vi.fn(async () => true),
    listMemoryConflicts: vi.fn(async () => [
      {
        id: 'p1',
        op: 'update' as const,
        relPath: 'nota.md',
        status: 'conflict' as const,
        reason: 'está na revisão 3, não 2',
        proposedBy: 'session:c1',
        updatedAt: '2026-09-10T12:00:00.000Z'
      }
    ]),
    discardMemoryProposal: vi.fn(async () => true),
    ...overrides
  }
  ;(window as unknown as { api: unknown }).api = api
  return api as unknown as Record<string, ReturnType<typeof vi.fn>>
}

/** fireEvent + a flushed microtask: the handlers here are async. */
async function click(element: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(element)
  })
}

const view = (): void => {
  render(
    <UiProvider>
      <MemoryDataSection />
    </UiProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Configurações → Dados: cofre e conflitos', () => {
  it('lista nomes e datas, nunca o valor do segredo', async () => {
    stubApi()
    view()
    expect(await screen.findByText('vps.deploy')).toBeTruthy()
    expect(document.body.textContent).not.toContain(SECRET_VALUE)
    // A tela não tem por onde pedir o valor: só apagar.
    expect(screen.queryByText(/mostrar valor/i)).toBeNull()
  })

  it('desligar o cofre aplica na hora e avisa que as chaves continuam salvas', async () => {
    const api = stubApi()
    view()
    const toggle = (await screen.findAllByRole('checkbox'))[0]
    await click(toggle)
    await waitFor(() => expect(api.setConfig).toHaveBeenCalledWith({ secretVaultEnabled: false }))
    // O texto aparece na descrição e no toast: basta existir no toast.
    expect(await screen.findAllByText(/continuam salvas/i)).not.toHaveLength(0)
  })

  it('reverte o interruptor quando a gravação falha, em vez de mentir', async () => {
    const api = stubApi({ setConfig: vi.fn(async () => { throw new Error('storage offline') }) })
    view()
    const toggle = (await screen.findAllByRole('checkbox'))[0] as HTMLInputElement
    await click(toggle)
    await waitFor(() => expect(api.setConfig).toHaveBeenCalled())
    await waitFor(() => expect(toggle.checked).toBe(true))
    expect(await screen.findByText(/não foi possível alterar o cofre/i)).toBeTruthy()
  })

  it('apagar uma chave pede confirmação antes', async () => {
    const api = stubApi()
    view()
    await click(await screen.findByRole('button', { name: 'Apagar' }))
    // Só abriu o modal: nada foi apagado ainda.
    expect(api.deleteSecret).not.toHaveBeenCalled()
    const confirmButton = (await screen.findAllByRole('button', { name: 'Apagar' }))
      .find((button) => button.className.includes('danger'))!
    await click(confirmButton)
    await waitFor(() => expect(api.deleteSecret).toHaveBeenCalledWith('vps.deploy'))
    await waitFor(() => expect(screen.queryByText('vps.deploy')).toBeNull())
  })

  it('mostra o conflito com o motivo e some ao descartar', async () => {
    const api = stubApi()
    view()
    expect(await screen.findByText(/está na revisão 3, não 2/)).toBeTruthy()
    await click(await screen.findByRole('button', { name: 'Descartar' }))
    await waitFor(() => expect(api.discardMemoryProposal).toHaveBeenCalledWith('p1'))
    await waitFor(() => expect(screen.queryByText(/está na revisão 3/)).toBeNull())
  })

  it('sem conflito, a seção de falhas não aparece', async () => {
    stubApi({ listMemoryConflicts: vi.fn(async () => []) })
    view()
    await screen.findByText('vps.deploy')
    expect(screen.queryByText(/Memórias que não foram salvas/i)).toBeNull()
  })
})
