/** A pílula com o nome da filial, o menu "Suas filiais" (só no APK) e a confirmação de esquecer. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { confirmForget } from '../app/filiais'
import { client, nav } from '../app/runtime'
import { CASA, EMPRESA, resetApp, savePc, setApk, twoPcs } from '../app/testSupport'
import { loadPcs, renamePc } from '../core/pcs'
import { StatusMenu, StatusPill } from './StatusMenu'

const rowTexts = (): Array<string | null | undefined> => screen.getAllByRole('button').map((b) => b.textContent?.trim())

describe('StatusPill', () => {
  beforeEach(resetApp)
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('mostra o nome da filial ativa, com o estado só no ponto e no aria-label', () => {
    twoPcs()
    render(<StatusPill />)
    const pill = screen.getByRole('button', { name: 'Filial Casa, offline — abrir menu' })
    expect(pill.textContent?.trim()).toBe('Casa')
    expect(pill.className).toBe('status off')
    expect(pill.querySelector('.dot')).not.toBeNull()
    expect(pill.querySelector('.status-caret')).not.toBeNull() // o ▾ de "abre um menu"
    act(() => client.store.set({ online: true }))
    expect(screen.getByRole('button', { name: 'Filial Casa, online — abrir menu' }).className).toBe('status on')
  })

  it('filial sem apelido aparece como "PC N"', () => {
    savePc(CASA, null, 100)
    render(<StatusPill />)
    expect(screen.getByRole('button', { name: /^Filial PC 1,/ }).textContent?.trim()).toBe('PC 1')
  })

  it('o nome novo aparece na hora (renomear atualiza o pcsStore)', () => {
    const { casa } = twoPcs()
    render(<StatusPill />)
    act(() => {
      renamePc(casa, 'Matriz')
    })
    expect(screen.getByRole('button', { name: /^Filial Matriz,/ }).textContent?.trim()).toBe('Matriz')
  })

  it('sem filial salva (navegador): o texto de hoje, "offline" / "online"', () => {
    render(<StatusPill />)
    expect(screen.getByRole('button', { name: /offline/ }).textContent?.trim()).toBe('offline')
    act(() => client.store.set({ online: true }))
    expect(screen.getByRole('button', { name: /online/ }).textContent?.trim()).toBe('online')
  })

  it('um toque abre o menu; outro fecha', () => {
    twoPcs()
    render(<StatusPill />)
    fireEvent.click(screen.getByRole('button'))
    expect(nav.get().statusMenuOpen).toBe(true)
    fireEvent.click(screen.getByRole('button'))
    expect(nav.get().statusMenuOpen).toBe(false)
  })
})

describe('StatusMenu no APK', () => {
  beforeEach(() => {
    resetApp()
    setApk(true)
    nav.set({ statusMenuOpen: true })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    setApk(false)
  })

  it('"Suas filiais", as duas filiais na ordem salva, ✓ na ativa e "Abrir filial" logo abaixo', () => {
    twoPcs()
    const { container } = render(<StatusMenu />)
    expect(screen.getByText('Suas filiais').className).toContain('popover-title')
    expect(rowTexts()).toEqual(['Casa', 'Empresa', 'Abrir filial', 'Configurações', 'Esquecer esta filial'])
    const casa = screen.getByRole('button', { name: 'Casa' })
    const empresa = screen.getByRole('button', { name: 'Empresa' })
    expect(casa.querySelector('.filial-check')).not.toBeNull()
    expect(casa.getAttribute('aria-current')).toBe('true')
    expect(empresa.querySelector('.filial-check')).toBeNull()
    expect(empresa.getAttribute('aria-current')).toBeNull()
    expect(container.querySelector('.popover-sep')).not.toBeNull() // o separador entre a lista e as ações
    expect(container.querySelector('.popover-info')).toBeNull() // no APK o endereço fica nas Configurações
  })

  it('o ponto da ativa segue online/offline; as outras são ○ (o app não sabe o estado delas)', () => {
    twoPcs()
    render(<StatusMenu />)
    const dot = (name: string): string => screen.getByRole('button', { name }).querySelector('.filial-dot')?.className ?? ''
    expect(dot('Casa')).toBe('filial-dot off')
    expect(dot('Empresa')).toBe('filial-dot')
    act(() => client.store.set({ online: true }))
    expect(dot('Casa')).toBe('filial-dot on')
    expect(dot('Empresa')).toBe('filial-dot')
  })

  it('"Abrir filial" aparece mesmo com uma filial só', () => {
    savePc(CASA, 'Casa', 100)
    render(<StatusMenu />)
    expect(screen.getByRole('button', { name: /Abrir filial/ })).toBeDefined()
    expect(rowTexts()).toEqual(['Casa', 'Abrir filial', 'Configurações', 'Esquecer esta filial'])
  })

  it('tocar em outra filial troca para ela (client.switchPc com o id dela) e fecha o menu', () => {
    const { empresa } = twoPcs()
    const switchPc = vi.spyOn(client, 'switchPc').mockImplementation(() => {})
    render(<StatusMenu />)
    fireEvent.click(screen.getByRole('button', { name: 'Empresa' }))
    expect(switchPc).toHaveBeenCalledTimes(1)
    expect(switchPc).toHaveBeenCalledWith(empresa)
    expect(nav.get().statusMenuOpen).toBe(false)
  })

  it('tocar na filial ativa só fecha o menu', () => {
    twoPcs()
    const switchPc = vi.spyOn(client, 'switchPc').mockImplementation(() => {})
    render(<StatusMenu />)
    fireEvent.click(screen.getByRole('button', { name: 'Casa' }))
    expect(switchPc).not.toHaveBeenCalled()
    expect(nav.get().statusMenuOpen).toBe(false)
  })

  it('"Abrir filial" abre o leitor de QR por cima e fecha o menu', () => {
    twoPcs()
    render(<StatusMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Abrir filial/ }))
    expect(nav.get().scanOpen).toBe(true)
    expect(nav.get().statusMenuOpen).toBe(false)
  })

  it('"Configurações" abre o painel e fecha o menu', () => {
    twoPcs()
    render(<StatusMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Configurações/ }))
    expect(nav.get().settingsOpen).toBe(true)
    expect(nav.get().statusMenuOpen).toBe(false)
  })

  it('"Esquecer esta filial" só esquece depois do confirm: cancelar não chama forgetPc', () => {
    const { casa } = twoPcs()
    const forget = vi.spyOn(client, 'forgetPc').mockImplementation(() => {})
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<StatusMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Esquecer esta filial/ }))
    expect(confirm).toHaveBeenCalledWith('Esquecer a filial Casa? Para voltar a ela, escaneie o QR dela de novo.')
    expect(forget).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: /Esquecer esta filial/ }))
    expect(forget).toHaveBeenCalledTimes(1)
    expect(forget).toHaveBeenCalledWith(casa)
  })

  it('o scrim fecha o menu', () => {
    twoPcs()
    const { container } = render(<StatusMenu />)
    fireEvent.click(container.querySelector('.scrim') as HTMLElement)
    expect(nav.get().statusMenuOpen).toBe(false)
  })

  it('fechado, não renderiza nada', () => {
    twoPcs()
    nav.set({ statusMenuOpen: false })
    const { container } = render(<StatusMenu />)
    expect(container.firstChild).toBeNull()
  })
})

describe('StatusMenu no navegador (sem window.Capacitor)', () => {
  beforeEach(() => {
    resetApp()
    nav.set({ statusMenuOpen: true })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('sem lista e sem "Abrir filial": o endereço em uso, Configurações e a saída da conexão', () => {
    client.store.set({ base: 'https://relay.casa' })
    const { container } = render(<StatusMenu />)
    expect(container.querySelector('.popover-info')?.textContent).toBe('relay.casa')
    expect(screen.queryByText('Suas filiais')).toBeNull()
    expect(screen.queryByRole('button', { name: /Abrir filial/ })).toBeNull()
    expect(rowTexts()).toEqual(['Configurações', 'Sair desta conexão'])
  })

  it('sem endereço ainda: "conectado", como hoje', () => {
    const { container } = render(<StatusMenu />)
    expect(container.querySelector('.popover-info')?.textContent).toBe('conectado')
  })

  it('"Sair desta conexão" (sem filial salva) pergunta e chama forgetPc(null)', () => {
    const forget = vi.spyOn(client, 'forgetPc').mockImplementation(() => {})
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<StatusMenu />)
    fireEvent.click(screen.getByRole('button', { name: /Sair desta conexão/ }))
    expect(confirm).toHaveBeenCalledWith('Sair desta conexão?')
    expect(forget).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: /Sair desta conexão/ }))
    expect(forget).toHaveBeenCalledWith(null)
    expect(nav.get().statusMenuOpen).toBe(false)
  })

  it('com filial salva (migrada do app antigo), o rótulo é "Esquecer esta filial" e a lista continua escondida', () => {
    savePc(EMPRESA, 'Empresa', 100)
    render(<StatusMenu />)
    expect(rowTexts()).toEqual(['Configurações', 'Esquecer esta filial'])
    expect(screen.queryByText('Suas filiais')).toBeNull()
  })
})

describe('confirmForget', () => {
  beforeEach(resetApp)
  afterEach(() => vi.restoreAllMocks())

  it('sem argumento esquece a filial ativa; com o id, a que foi pedida', () => {
    const { casa, empresa } = twoPcs()
    const forget = vi.spyOn(client, 'forgetPc').mockImplementation(() => {})
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    confirmForget()
    expect(confirm).toHaveBeenLastCalledWith('Esquecer a filial Casa? Para voltar a ela, escaneie o QR dela de novo.')
    expect(forget).toHaveBeenLastCalledWith(casa)
    confirmForget(empresa)
    expect(confirm).toHaveBeenLastCalledWith('Esquecer a filial Empresa? Para voltar a ela, escaneie o QR dela de novo.')
    expect(forget).toHaveBeenLastCalledWith(empresa)
  })

  it('null = conexão que não é uma filial salva: "Sair desta conexão?"', () => {
    twoPcs()
    const forget = vi.spyOn(client, 'forgetPc').mockImplementation(() => {})
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    confirmForget(null)
    expect(confirm).toHaveBeenCalledWith('Sair desta conexão?')
    expect(forget).toHaveBeenCalledWith(null)
  })

  it('o nome na pergunta é o "PC N" de quem ainda não tem apelido', () => {
    savePc(CASA, null, 100)
    const empresa = savePc(EMPRESA, null, 200)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    confirmForget(empresa)
    expect(confirm).toHaveBeenCalledWith('Esquecer a filial PC 2? Para voltar a ela, escaneie o QR dela de novo.')
  })

  it('id que não está (mais) salvo: não pergunta e não esquece nada', () => {
    twoPcs()
    const forget = vi.spyOn(client, 'forgetPc').mockImplementation(() => {})
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    confirmForget('pc-que-nao-existe')
    expect(confirm).not.toHaveBeenCalled()
    expect(forget).not.toHaveBeenCalled()
  })

  it('cancelar no confirm não fecha menu nem Configurações', () => {
    twoPcs()
    nav.set({ statusMenuOpen: true, settingsOpen: true })
    vi.spyOn(client, 'forgetPc').mockImplementation(() => {})
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    confirmForget()
    expect(nav.get().statusMenuOpen).toBe(true)
    expect(nav.get().settingsOpen).toBe(true)
  })

  it('esquecer a ativa fecha menu e Configurações; esquecer uma inativa mantém as Configurações abertas', () => {
    const { empresa } = twoPcs()
    vi.spyOn(client, 'forgetPc').mockImplementation(() => {})
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    nav.set({ statusMenuOpen: true, settingsOpen: true })
    confirmForget(empresa) // não é a ativa: o painel onde se gerenciam as filiais continua aberto
    expect(nav.get().settingsOpen).toBe(true)
    expect(nav.get().statusMenuOpen).toBe(false)
    confirmForget() // a ativa: o app recarrega / volta ao QR, o painel não pode ficar para trás
    expect(nav.get().settingsOpen).toBe(false)
    expect(loadPcs().pcs).toHaveLength(2) // o spy não apagou nada: quem apaga é o client (testado no client.test)
  })
})
