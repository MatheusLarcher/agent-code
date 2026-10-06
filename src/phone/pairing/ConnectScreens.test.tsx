/** As telas antes do app: QR, Reconectando (com troca de filial) e "Outro celular pareado". */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { client, nav } from '../app/runtime'
import { CASA, MATRIZ, resetApp, savePc, setApk, twoPcs } from '../app/testSupport'
import { renamePc, setActivePc } from '../core/pcs'
import { BlockedScreen, PairingScreen, PairScreen } from './ConnectScreens'

const buttonTexts = (): Array<string | null | undefined> => screen.getAllByRole('button').map((b) => b.textContent?.trim())

describe('PairScreen (tela do QR)', () => {
  beforeEach(resetApp)
  afterEach(cleanup)

  it('"Escanear QR" abre o leitor único (openScanner), sem um leitor próprio', () => {
    const { container } = render(<PairScreen />)
    fireEvent.click(screen.getByRole('button', { name: /Escanear QR/ }))
    expect(nav.get().scanOpen).toBe(true)
    expect(container.querySelector('.scanner')).toBeNull() // o leitor é montado pelo App, por cima de qualquer tela
  })
})

describe('PairingScreen (Reconectando) no APK', () => {
  beforeEach(() => {
    resetApp()
    setApk(true)
    client.store.set({ pairingDetail: 'O PC não respondeu. Vou tentar de novo automaticamente.', pairingStatus: 'Tentando novamente em 4 s…' })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    setApk(false)
  })

  it('mostra a filial que está sendo tentada, sob o título, e o estado da tentativa', () => {
    twoPcs()
    const { container } = render(<PairingScreen />)
    expect(screen.getByRole('heading', { name: 'Reconectando' })).toBeDefined()
    expect(container.querySelector('.reconnect-filial')?.textContent).toBe('Filial Casa')
    expect(screen.getByText('O PC não respondeu. Vou tentar de novo automaticamente.')).toBeDefined()
    expect(screen.getByText('Tentando novamente em 4 s…')).toBeDefined()
  })

  it('"Trocar para a filial Empresa" chama client.switchPc com o id dela', () => {
    const { empresa } = twoPcs()
    const switchPc = vi.spyOn(client, 'switchPc').mockImplementation(() => {})
    render(<PairingScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'Trocar para a filial Empresa' }))
    expect(switchPc).toHaveBeenCalledTimes(1)
    expect(switchPc).toHaveBeenCalledWith(empresa)
  })

  it('ordem: trocas (da usada há menos tempo à mais antiga), "Abrir filial" e, por último, o esquecer', () => {
    const { casa } = twoPcs() // Casa (ativa), Empresa usada em 200
    savePc(MATRIZ, 'Matriz', 250) // usada mais recentemente que a Empresa
    setActivePc(casa, 400)
    render(<PairingScreen />)
    expect(buttonTexts()).toEqual(['Trocar para a filial Matriz', 'Trocar para a filial Empresa', 'Abrir filial', 'Esquecer esta filial'])
  })

  it('só a ativa salva: sem botão de troca, mas com "Abrir filial"', () => {
    savePc(CASA, 'Casa', 100)
    render(<PairingScreen />)
    expect(buttonTexts()).toEqual(['Abrir filial', 'Esquecer esta filial'])
  })

  it('"Abrir filial" abre o leitor de QR', () => {
    twoPcs()
    render(<PairingScreen />)
    fireEvent.click(screen.getByRole('button', { name: /Abrir filial/ }))
    expect(nav.get().scanOpen).toBe(true)
  })

  it('"Esquecer esta filial" é secundário (mais fraco que as trocas) e só esquece depois do confirm', () => {
    const { casa } = twoPcs()
    const forget = vi.spyOn(client, 'forgetPc').mockImplementation(() => {})
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<PairingScreen />)
    const esquecer = screen.getByRole('button', { name: 'Esquecer esta filial' })
    expect(esquecer.className).toContain('reconnect-forget')
    expect(esquecer.className).not.toContain('primary')
    expect(screen.getByRole('button', { name: 'Trocar para a filial Empresa' }).className).toContain('primary')
    fireEvent.click(esquecer)
    expect(confirm).toHaveBeenCalledWith('Esquecer a filial Casa? Para voltar a ela, escaneie o QR dela de novo.')
    expect(forget).not.toHaveBeenCalled() // cancelar: nada é apagado
    confirm.mockReturnValue(true)
    fireEvent.click(esquecer)
    expect(forget).toHaveBeenCalledTimes(1)
    expect(forget).toHaveBeenCalledWith(casa) // o id da ativa, não o evento do clique
  })

  it('nada na tela apaga sem confirmação: trocar e abrir não chamam forgetPc', () => {
    twoPcs()
    const forget = vi.spyOn(client, 'forgetPc').mockImplementation(() => {})
    vi.spyOn(client, 'switchPc').mockImplementation(() => {})
    render(<PairingScreen />)
    fireEvent.click(screen.getByRole('button', { name: /Trocar para a filial/ }))
    fireEvent.click(screen.getByRole('button', { name: /Abrir filial/ }))
    expect(forget).not.toHaveBeenCalled()
  })

  it('o nome novo da filial (renomeada nas Configurações, ou o hostname que chega depois) aparece na hora', () => {
    const { casa, empresa } = twoPcs()
    const { container } = render(<PairingScreen />)
    act(() => {
      renamePc(casa, 'Matriz')
      renamePc(empresa, 'Filial Norte')
    })
    expect(container.querySelector('.reconnect-filial')?.textContent).toBe('Filial Matriz')
    expect(screen.getByRole('button', { name: 'Trocar para a filial Filial Norte' })).toBeDefined()
  })
})

describe('PairingScreen (Reconectando) no navegador', () => {
  beforeEach(() => {
    resetApp()
    client.store.set({ pairingDetail: '', pairingStatus: 'Conectando…' })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('sem filial salva: texto padrão, sem trocas nem "Abrir filial", e a saída é "Sair desta conexão"', () => {
    const forget = vi.spyOn(client, 'forgetPc').mockImplementation(() => {})
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container } = render(<PairingScreen />)
    expect(screen.getByText('Procurando a ponte do seu PC…')).toBeDefined()
    expect(container.querySelector('.reconnect-filial')).toBeNull()
    expect(buttonTexts()).toEqual(['Sair desta conexão'])
    fireEvent.click(screen.getByRole('button', { name: 'Sair desta conexão' }))
    expect(confirm).toHaveBeenCalledWith('Sair desta conexão?')
    expect(forget).toHaveBeenCalledWith(null)
  })

  it('com filial salva (migrada), mostra o nome mas continua sem a lista de trocas', () => {
    twoPcs()
    const { container } = render(<PairingScreen />)
    expect(container.querySelector('.reconnect-filial')?.textContent).toBe('Filial Casa')
    expect(buttonTexts()).toEqual(['Esquecer esta filial'])
  })
})

describe('BlockedScreen (Outro celular pareado)', () => {
  beforeEach(() => {
    resetApp()
    client.store.set({ blockedName: 'Galaxy S24' })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('mostra quem está pareado; "Usar este celular" toma o lugar (takeover) e "Cancelar" sai sem apagar (leaveBlocked)', () => {
    const takeover = vi.spyOn(client, 'takeover').mockImplementation(() => {})
    const leave = vi.spyOn(client, 'leaveBlocked').mockImplementation(() => {})
    const forget = vi.spyOn(client, 'forgetPc').mockImplementation(() => {})
    render(<BlockedScreen />)
    expect(screen.getByText('Galaxy S24')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Usar este celular' }))
    expect(takeover).toHaveBeenCalledTimes(1)
    expect(leave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(leave).toHaveBeenCalledTimes(1)
    expect(forget).not.toHaveBeenCalled() // Cancelar nunca apaga a filial
  })
})
