import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ProvidersStatus } from '@shared/ipc'

const notify = vi.fn()
vi.mock('../../ui/UiProvider', () => ({ useUI: () => ({ notify }) }))

import { ConnectAccountCard } from './ConnectAccountCard'

const NONE: ProvidersStatus = { claude: false, gpt: false, ollama: false }

interface FakeApi {
  authLogin: ReturnType<typeof vi.fn>
  codexLogin: ReturnType<typeof vi.fn>
  providersStatus: ReturnType<typeof vi.fn>
  getConfig: ReturnType<typeof vi.fn>
  setConfig: ReturnType<typeof vi.fn>
}

let api: FakeApi
beforeEach(() => {
  notify.mockReset()
  api = {
    authLogin: vi.fn(async () => ({ ok: true })),
    codexLogin: vi.fn(async () => ({ ok: true })),
    providersStatus: vi.fn(async () => NONE),
    getConfig: vi.fn(async () => ({ ollama: { enabled: false, apiKey: '' } })),
    setConfig: vi.fn(async () => undefined)
  }
  ;(window as unknown as { api: FakeApi }).api = api
})
afterEach(() => cleanup())

function renderCard(status: ProvidersStatus | null = NONE, onConnected = vi.fn()) {
  const utils = render(<ConnectAccountCard status={status} onConnected={onConnected} />)
  return { ...utils, onConnected }
}

describe('ConnectAccountCard', () => {
  it('aparece só com os três desconectados', () => {
    const { rerender } = renderCard(NONE)
    expect(screen.getByRole('button', { name: 'Conectar conta' })).toBeTruthy()
    for (const status of [
      { ...NONE, claude: true },
      { ...NONE, gpt: true },
      { ...NONE, ollama: true },
      null
    ]) {
      rerender(<ConnectAccountCard status={status} onConnected={vi.fn()} />)
      expect(screen.queryByRole('button', { name: 'Conectar conta' })).toBeNull()
    }
  })

  it('abre as três opções', () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Conectar conta' }))
    expect(screen.getByRole('button', { name: 'Claude' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'GPT' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ollama' })).toBeTruthy()
  })

  it('Claude chama o login existente, mostra "Aguardando…" e avisa o sucesso', async () => {
    let finish: (v: { ok: boolean }) => void = () => undefined
    api.authLogin.mockImplementation(() => new Promise((r) => (finish = r)))
    api.providersStatus.mockResolvedValue({ ...NONE, claude: true })
    const { onConnected } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Conectar conta' }))
    fireEvent.click(screen.getByRole('button', { name: 'Claude' }))
    expect(api.authLogin).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Aguardando login no navegador…')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy()
    await act(async () => finish({ ok: true }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('sucesso', 'Conta conectada: Claude'))
    expect(onConnected).toHaveBeenCalledWith('claude')
  })

  it('GPT chama o login do Codex; falha avisa com erro e o card continua', async () => {
    api.codexLogin.mockResolvedValue({ ok: false, message: 'expirou' })
    const { onConnected } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Conectar conta' }))
    fireEvent.click(screen.getByRole('button', { name: 'GPT' }))
    expect(screen.getByText('Aguardando login no navegador…')).toBeTruthy()
    await waitFor(() => expect(notify).toHaveBeenCalledWith('erro', expect.stringContaining('expirou')))
    expect(onConnected).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Conectar conta' })).toBeTruthy()
  })

  it('Cancelar volta ao início com aviso e ignora o resultado tardio', async () => {
    let finish: (v: { ok: boolean }) => void = () => undefined
    api.authLogin.mockImplementation(() => new Promise((r) => (finish = r)))
    const { onConnected } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Conectar conta' }))
    fireEvent.click(screen.getByRole('button', { name: 'Claude' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(notify).toHaveBeenCalledWith('aviso', expect.any(String))
    expect(screen.getByRole('button', { name: 'Conectar conta' })).toBeTruthy()
    await act(async () => finish({ ok: true }))
    expect(onConnected).not.toHaveBeenCalled()
  })

  it('Ollama: chave vazia não habilita Salvar; Salvar grava enabled + chave', async () => {
    api.providersStatus.mockResolvedValue({ ...NONE, ollama: true })
    const { onConnected } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Conectar conta' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ollama' }))
    const save = screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    const input = screen.getByLabelText('API key do Ollama') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(screen.getByRole('link', { name: 'Gerar chave no ollama.com' })).toBeTruthy()
    fireEvent.change(input, { target: { value: '   ' } })
    expect(save.disabled).toBe(true)
    fireEvent.change(input, { target: { value: ' chave-123 ' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() =>
      expect(api.setConfig).toHaveBeenCalledWith({ ollama: { enabled: true, apiKey: 'chave-123' } })
    )
    await waitFor(() => expect(notify).toHaveBeenCalledWith('sucesso', 'Conta conectada: Ollama'))
    expect(onConnected).toHaveBeenCalledWith('ollama')
  })

  it('Ollama: falha ao gravar avisa com erro', async () => {
    api.setConfig.mockRejectedValue(new Error('disco cheio'))
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Conectar conta' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ollama' }))
    fireEvent.change(screen.getByLabelText('API key do Ollama'), { target: { value: 'k' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('erro', expect.stringContaining('disco cheio')))
  })

  it('some quando o status passa a ter um provedor conectado', () => {
    const { rerender } = renderCard(NONE)
    fireEvent.click(screen.getByRole('button', { name: 'Conectar conta' }))
    rerender(<ConnectAccountCard status={{ ...NONE, gpt: true }} onConnected={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Claude' })).toBeNull()
  })
})
