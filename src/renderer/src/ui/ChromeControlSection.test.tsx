// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SetupTask } from '@shared/setupTasks'
import { ChromeControlSection } from './ChromeControlSection'
import { UiProvider } from './UiProvider'

const DIR = 'C:\\Users\\Ana\\AppData\\Roaming\\agent-code-desktop\\chrome-extension'
const off = () => () => {}

function installApi(over: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    getConfig: vi.fn(async () => ({ chromeControlEnabled: false })),
    getChromeBridgeStatus: vi.fn(async () => ({ listening: true, port: 1, connected: false, extensionVersion: null, userAgent: null })),
    onChromeControlChanged: vi.fn(off),
    onChromeBridgeStatusChanged: vi.fn(off),
    setChromeControlEnabled: vi.fn(async () => undefined),
    setWindowsControlEnabled: vi.fn(async () => undefined),
    installChromeExtension: vi.fn(async () => DIR),
    ...over
  }
  ;(window as unknown as { api: unknown }).api = api
  return api as unknown as Record<string, ReturnType<typeof vi.fn>>
}

/** Faz o papel do App: aceita a tarefa e guarda o que chegou. */
function listen(): SetupTask[] {
  const got: SetupTask[] = []
  const onTask = (event: Event): void => {
    event.preventDefault()
    got.push((event as CustomEvent<SetupTask>).detail)
  }
  window.addEventListener('agentcode:setup-task', onTask)
  cleanups.push(() => window.removeEventListener('agentcode:setup-task', onTask))
  return got
}

const cleanups: Array<() => void> = []
const show = (): void => {
  render(
    <UiProvider>
      <ChromeControlSection />
    </UiProvider>
  )
}

beforeEach(() => {
  cleanups.length = 0
})
afterEach(() => {
  cleanups.forEach((fn) => fn())
  cleanup()
})

describe('ChromeControlSection — instalar a extensão', () => {
  it('"Instalar para mim" prepara a pasta sem abrir nada, liga os dois controles e manda o pedido ao agente', async () => {
    const api = installApi()
    const got = listen()
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Instalar para mim' }))
    await waitFor(() => expect(got).toHaveLength(1))
    expect(api.installChromeExtension).toHaveBeenCalledWith(false)
    expect(api.setWindowsControlEnabled).toHaveBeenCalledWith(true)
    expect(api.setChromeControlEnabled).toHaveBeenCalledWith(true)
    expect(got[0].id).toBe('chrome-extension')
    expect(got[0].prompt).toContain(DIR)
    expect(await screen.findByText(/Pedido enviado ao agente num chat novo/)).toBeTruthy()
    // O caminho automático não despeja os passos manuais na tela.
    expect(screen.queryByText(/Carregar sem compactação/)).toBeNull()
  })

  it('sem o chat para receber, avisa o erro em vez de fingir que pediu', async () => {
    installApi()
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Instalar para mim' }))
    expect(await screen.findByText(/Não foi possível pedir a instalação ao agente: o chat não está disponível agora/)).toBeTruthy()
  })

  it('falha ao preparar a pasta não liga controle nenhum', async () => {
    const api = installApi({
      installChromeExtension: vi.fn(async () => {
        throw new Error('Extensão não encontrada')
      })
    })
    const got = listen()
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Instalar para mim' }))
    expect(await screen.findByText(/Extensão não encontrada/)).toBeTruthy()
    expect(api.setWindowsControlEnabled).not.toHaveBeenCalled()
    expect(got).toHaveLength(0)
  })

  it('"Instalar manualmente" abre a pasta e a página e mostra os três passos, sem chamar o agente', async () => {
    const api = installApi()
    const got = listen()
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Instalar manualmente' }))
    expect(await screen.findByText(DIR)).toBeTruthy()
    expect(api.installChromeExtension).toHaveBeenCalledWith()
    expect(screen.getByText(/Carregar sem compactação/)).toBeTruthy()
    expect(api.setWindowsControlEnabled).not.toHaveBeenCalled()
    expect(got).toHaveLength(0)
  })

  it('com a extensão conectada, "Instalar para mim" deixa de ser o botão principal', async () => {
    installApi({
      getChromeBridgeStatus: vi.fn(async () => ({ listening: true, port: 1, connected: true, extensionVersion: '0.1.3', userAgent: 'Mozilla Chrome/140' }))
    })
    show()
    expect(await screen.findByText('Conectado · Chrome')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Instalar para mim' }).className).not.toContain('primary')
  })
})
