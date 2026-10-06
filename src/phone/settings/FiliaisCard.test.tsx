/** Configurações → card "Filiais" (APK): renomear, "em uso" com endereço/token e esquecer; no navegador, o card "Conexão". */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { client, toasts } from '../app/runtime'
import { CASA, EMPRESA, resetApp, savePc, twoPcs } from '../app/testSupport'
import { loadPcs, namePcIfUnnamed, pcsStore } from '../core/pcs'
import { ConexaoCard, FiliaisCard } from './FiliaisCard'

const field = (value: string): HTMLInputElement => screen.getByDisplayValue(value) as HTMLInputElement
const blockOf = (input: HTMLElement): HTMLElement => input.closest('.cfg-filial') as HTMLElement
const saveOf = (input: HTMLElement): HTMLButtonElement => within(blockOf(input)).getByRole('button', { name: /Salvar/ }) as HTMLButtonElement
const type = (input: HTMLElement, value: string): void => {
  fireEvent.change(input, { target: { value } })
}
const lastToast = (): { text: string; tipo?: string } | undefined => toasts.get().list.at(-1)

describe('FiliaisCard (APK)', () => {
  beforeEach(() => {
    resetApp()
    window.Capacitor = {}
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    delete window.Capacitor
  })

  it('título "Filiais" e uma linha por filial salva, com a ativa marcada "em uso"', () => {
    twoPcs()
    const { container } = render(<FiliaisCard />)
    expect(container.querySelector('.cfg-card-title')?.textContent).toBe('Filiais')
    expect(container.querySelectorAll('.cfg-filial')).toHaveLength(2)
    expect(screen.getAllByText('em uso')).toHaveLength(1)
    expect(within(blockOf(field('Casa'))).queryByText('em uso')).not.toBeNull()
    expect(within(blockOf(field('Empresa'))).queryByText('em uso')).toBeNull()
  })

  it('endereço em uso (sem http/https) e token só na filial ativa', () => {
    twoPcs()
    client.store.set({ base: 'https://relay.casa', token: 'tCasa' })
    render(<FiliaisCard />)
    const casa = within(blockOf(field('Casa')))
    expect(casa.getByText('Endereço')).toBeDefined()
    expect(casa.getByText('relay.casa')).toBeDefined()
    expect(casa.getByText('Token')).toBeDefined()
    expect(casa.getByText('tCasa')).toBeDefined()
    const empresa = within(blockOf(field('Empresa')))
    expect(empresa.queryByText('Endereço')).toBeNull()
    expect(empresa.queryByText('Token')).toBeNull()
  })

  it('o endereço em uso é o da conexão (LAN ou relay), não o salvo', () => {
    twoPcs()
    client.store.set({ base: 'http://192.168.0.10:8765', token: 'tCasa' })
    render(<FiliaisCard />)
    expect(screen.getByText('192.168.0.10:8765')).toBeDefined()
  })

  it('o nome é editável; sem apelido o campo vem vazio com o placeholder "PC N"', () => {
    savePc(CASA, null, 100)
    savePc(EMPRESA, null, 200)
    render(<FiliaisCard />)
    const fields = screen.getAllByRole('textbox') as HTMLInputElement[]
    expect(fields.map((f) => f.value)).toEqual(['', ''])
    expect(fields.map((f) => f.placeholder)).toEqual(['PC 1', 'PC 2'])
  })

  it('"Salvar" só habilita quando o nome mudou e não está vazio', () => {
    twoPcs()
    render(<FiliaisCard />)
    const casa = field('Casa')
    expect(saveOf(casa).disabled).toBe(true) // nada mudou
    type(casa, '')
    expect(saveOf(casa).disabled).toBe(true) // vazio
    type(casa, '   ')
    expect(saveOf(casa).disabled).toBe(true) // só espaços
    type(casa, 'Casa ') // só espaço a mais: o mesmo nome
    expect(saveOf(casa).disabled).toBe(true)
    type(casa, 'Casa nova')
    expect(saveOf(casa).disabled).toBe(false)
    expect(saveOf(field('Empresa')).disabled).toBe(true) // o estado de uma linha não vaza para a outra
  })

  it('Salvar renomeia de verdade (pcsStore muda na hora) e avisa com toast de sucesso', () => {
    const { casa } = twoPcs()
    render(<FiliaisCard />)
    const input = field('Casa')
    type(input, '  Casa nova ')
    fireEvent.click(saveOf(input))
    expect(pcsStore.get().pcs.find((p) => p.id === casa)?.nome).toBe('Casa nova') // aparado, como o renamePc faz
    expect(loadPcs().pcs.find((p) => p.id === casa)?.nome).toBe('Casa nova') // e gravado no armazenamento
    expect(lastToast()).toMatchObject({ text: 'Filial renomeada', tipo: 'sucesso' })
    const novo = field('Casa nova')
    expect(saveOf(novo).disabled).toBe(true) // salvo: nada mais a salvar
  })

  it('Enter no campo (envio do formulário) também salva', () => {
    const { empresa } = twoPcs()
    render(<FiliaisCard />)
    const input = field('Empresa')
    type(input, 'Matriz')
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    expect(pcsStore.get().pcs.find((p) => p.id === empresa)?.nome).toBe('Matriz')
    expect(lastToast()).toMatchObject({ text: 'Filial renomeada', tipo: 'sucesso' })
  })

  it('Enter com o campo vazio (ou sem mudança) não salva nem avisa', () => {
    twoPcs()
    render(<FiliaisCard />)
    const input = field('Casa')
    type(input, '')
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    type(input, 'Casa')
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    expect(pcsStore.get().pcs.map((p) => p.nome)).toEqual(['Casa', 'Empresa'])
    expect(toasts.get().list).toEqual([])
  })

  it('o nome que chega de fora (o hostname do PC depois de conectar) aparece no campo de quem não está editando', () => {
    savePc(CASA, null, 100)
    render(<FiliaisCard />)
    expect(screen.getByRole('textbox')).toHaveProperty('value', '')
    act(() => {
      namePcIfUnnamed(CASA.token, 'Matheus-2D')
    })
    expect(screen.getByRole('textbox')).toHaveProperty('value', 'Matheus-2D')
  })

  it('"Esquecer" em cada filial pergunta com o nome dela e só esquece com o ok: cancelar não chama forgetPc', () => {
    const { casa, empresa } = twoPcs()
    const forget = vi.spyOn(client, 'forgetPc').mockImplementation(() => {})
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<FiliaisCard />)
    const buttons = screen.getAllByRole('button', { name: 'Esquecer' }) // o nome visível é o nome acessível; o contexto vai no title e no grupo
    expect(buttons).toHaveLength(2)
    expect(buttons.map((b) => b.title)).toEqual(['Esquecer a filial Casa', 'Esquecer a filial Empresa'])
    expect(screen.getByRole('group', { name: 'Empresa' })).toBe(blockOf(field('Empresa')))
    fireEvent.click(within(blockOf(field('Empresa'))).getByRole('button', { name: /Esquecer/ }))
    expect(confirm).toHaveBeenLastCalledWith('Esquecer a filial Empresa? Para voltar a ela, escaneie o QR dela de novo.')
    expect(forget).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    fireEvent.click(within(blockOf(field('Empresa'))).getByRole('button', { name: /Esquecer/ }))
    expect(forget).toHaveBeenLastCalledWith(empresa)
    fireEvent.click(within(blockOf(field('Casa'))).getByRole('button', { name: /Esquecer/ }))
    expect(confirm).toHaveBeenLastCalledWith('Esquecer a filial Casa? Para voltar a ela, escaneie o QR dela de novo.')
    expect(forget).toHaveBeenLastCalledWith(casa)
  })

  it('o campo respeita o limite de 60 caracteres do apelido', () => {
    twoPcs()
    render(<FiliaisCard />)
    expect(field('Casa').maxLength).toBe(60)
  })
})

describe('ConexaoCard (navegador)', () => {
  beforeEach(resetApp)
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('o card "Conexão" de hoje: endereço (sem http), token e a saída, sem filial salva', () => {
    client.store.set({ base: 'https://relay.casa', token: 'tCasa' })
    const forget = vi.spyOn(client, 'forgetPc').mockImplementation(() => {})
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container } = render(<ConexaoCard />)
    expect(container.querySelector('.cfg-card-title')?.textContent).toBe('Conexão')
    expect(screen.getByText('relay.casa')).toBeDefined()
    expect(screen.getByText('tCasa')).toBeDefined()
    expect(screen.queryByRole('textbox')).toBeNull() // sem lista nem edição de nome
    fireEvent.click(screen.getByRole('button', { name: 'Sair desta conexão' }))
    expect(confirm).toHaveBeenCalledWith('Sair desta conexão?')
    expect(forget).toHaveBeenCalledWith(null)
  })

  it('sem conexão ainda, mostra "—" no endereço e no token', () => {
    render(<ConexaoCard />)
    expect(screen.getAllByText('—')).toHaveLength(2)
  })

  it('com filial salva (migrada), o rótulo vira "Esquecer esta filial" e esquece a ativa', () => {
    const casa = savePc(CASA, 'Casa', 100)
    const forget = vi.spyOn(client, 'forgetPc').mockImplementation(() => {})
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ConexaoCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Esquecer esta filial' }))
    expect(forget).toHaveBeenCalledWith(casa)
  })
})
