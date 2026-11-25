// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SUPORTE_LINK_CLIENTE, type SuporteAjustes, type SuporteAjustesPatch } from '@shared/suporteRemoto'
import { SuporteRemotoSection } from './SuporteRemotoSection'
import { UiProvider } from './UiProvider'

// Só para o teste: nunca uma chave de verdade.
const CHAVE = 'chave-de-teste-somente-para-a-tela-0001'

function instalarApi(inicial: SuporteAjustes): { salvar: ReturnType<typeof vi.fn>; atual: () => SuporteAjustes } {
  let ajustes = inicial
  const salvar = vi.fn(async (patch: SuporteAjustesPatch) => {
    if (patch.ativado && !ajustes.temChave && !patch.chave) return { ok: false, mensagem: 'Cole a chave da equipe antes de ativar o suporte remoto.' }
    ajustes = {
      ativado: patch.chave === '' ? false : (patch.ativado ?? ajustes.ativado),
      tecnico: patch.tecnico?.trim() ?? ajustes.tecnico,
      temChave: patch.chave === undefined ? ajustes.temChave : Boolean(patch.chave)
    }
    return { ok: true, ajustes }
  })
  ;(window as unknown as { api: unknown }).api = {
    getSuporteAjustes: vi.fn(async () => ajustes),
    getSuporteStatus: vi.fn(async () => ({ estado: 'desligado', convId: null })),
    onSuporteAjustesMudou: vi.fn(() => () => undefined),
    onSuporteStatusMudou: vi.fn(() => () => undefined),
    salvarSuporteAjustes: salvar
  }
  return { salvar, atual: () => ajustes }
}

const mostrar = (): void => {
  render(
    <UiProvider>
      <SuporteRemotoSection />
    </UiProvider>
  )
}
const interruptor = (): HTMLInputElement => screen.getByRole('checkbox') as HTMLInputElement

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SuporteRemotoSection', () => {
  it('sem chave, o interruptor não liga e a tela diz o que falta', async () => {
    const { salvar } = instalarApi({ ativado: false, tecnico: '', temChave: false })
    mostrar()
    expect(await screen.findByText('Salve a chave da equipe para ativar.')).toBeTruthy()
    expect(interruptor().disabled).toBe(true)
    expect(interruptor().checked).toBe(false)
    fireEvent.click(interruptor())
    expect(salvar).not.toHaveBeenCalled()
  })

  it('com a chave salva, o interruptor liga e desliga', async () => {
    const { salvar } = instalarApi({ ativado: false, tecnico: 'Ana', temChave: true })
    mostrar()
    await screen.findByText('Chave salva')
    expect(interruptor().disabled).toBe(false)
    fireEvent.click(interruptor())
    await waitFor(() => expect(salvar).toHaveBeenCalledWith({ ativado: true }))
    expect(await screen.findByText('Suporte remoto ativado.')).toBeTruthy()
    await waitFor(() => expect(interruptor().checked).toBe(true))
    fireEvent.click(interruptor())
    await waitFor(() => expect(salvar).toHaveBeenLastCalledWith({ ativado: false }))
  })

  it('a chave nunca aparece em claro depois de salva', async () => {
    const { salvar } = instalarApi({ ativado: false, tecnico: '', temChave: false })
    const { container } = render(
      <UiProvider>
        <SuporteRemotoSection />
      </UiProvider>
    )
    const campo = (await screen.findByLabelText('Chave da Equipe')) as HTMLInputElement
    expect(campo.type).toBe('password')
    fireEvent.change(campo, { target: { value: `  ${CHAVE}  ` } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar chave' }))
    await waitFor(() => expect(salvar).toHaveBeenCalledWith({ chave: CHAVE }))
    // Salva: o campo some, fica só "Chave salva", e o valor não está em lugar nenhum da tela.
    expect(await screen.findByText('Chave salva')).toBeTruthy()
    expect(screen.queryByLabelText('Chave da Equipe')).toBeNull()
    expect(container.innerHTML).not.toContain(CHAVE)
    expect(document.body.innerHTML).not.toContain(CHAVE)
    // "Trocar" abre um campo VAZIO: não há como reler a chave salva.
    fireEvent.click(screen.getByRole('button', { name: 'Trocar' }))
    expect((screen.getByLabelText('Chave da Equipe') as HTMLInputElement).value).toBe('')
    expect(screen.queryByRole('button', { name: /Mostrar chave/ })).toBeTruthy()
  })

  it('apagar a chave pede confirmação e desliga o recurso', async () => {
    const { salvar, atual } = instalarApi({ ativado: true, tecnico: 'Ana', temChave: true })
    mostrar()
    await screen.findByText('Chave salva')
    fireEvent.click(screen.getByRole('button', { name: 'Apagar' }))
    expect(await screen.findByText('Apagar a Chave da Equipe?')).toBeTruthy()
    expect(salvar).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Apagar chave' }))
    await waitFor(() => expect(salvar).toHaveBeenCalledWith({ chave: '' }))
    await waitFor(() => expect(atual()).toEqual({ ativado: false, tecnico: 'Ana', temChave: false }))
    await waitFor(() => expect(interruptor().checked).toBe(false))
    expect(interruptor().disabled).toBe(true)
  })

  it('o nome só salva quando muda; erro do main aparece em toast', async () => {
    const { salvar } = instalarApi({ ativado: false, tecnico: 'Ana', temChave: true })
    mostrar()
    const nome = (await screen.findByLabelText('Seu Nome')) as HTMLInputElement
    await waitFor(() => expect(nome.value).toBe('Ana'))
    const botao = screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement
    expect(botao.disabled).toBe(true)
    fireEvent.change(nome, { target: { value: 'Ana Paula' } })
    expect(botao.disabled).toBe(false)
    salvar.mockResolvedValueOnce({ ok: false, mensagem: 'O nome tem no máximo 40 caracteres.' })
    fireEvent.click(botao)
    expect(await screen.findByText('O nome tem no máximo 40 caracteres.')).toBeTruthy()
    fireEvent.click(botao)
    await waitFor(() => expect(salvar).toHaveBeenLastCalledWith({ tecnico: 'Ana Paula' }))
    expect(await screen.findByText('Nome salvo.')).toBeTruthy()
  })

  it('o link do cliente é o curto e o botão copia', async () => {
    instalarApi({ ativado: true, tecnico: 'Ana', temChave: true })
    const copiar = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: copiar }, configurable: true })
    mostrar()
    expect(await screen.findByText(SUPORTE_LINK_CLIENTE)).toBeTruthy()
    const botao = screen.getByRole('button', { name: 'Copiar link' })
    // Dica própria do app, nunca o `title` nativo.
    expect(botao.getAttribute('data-tip')).toBe('Copiar link')
    expect(botao.getAttribute('title')).toBeNull()
    fireEvent.click(botao)
    await waitFor(() => expect(copiar).toHaveBeenCalledWith(SUPORTE_LINK_CLIENTE))
    expect(await screen.findByText('Link copiado.')).toBeTruthy()
  })

  it('texto visível não cita "Claude" e os títulos seguem o padrão', async () => {
    instalarApi({ ativado: false, tecnico: '', temChave: false })
    const { container } = render(
      <UiProvider>
        <SuporteRemotoSection />
      </UiProvider>
    )
    await screen.findByText('Salve a chave da equipe para ativar.')
    expect(container.textContent).not.toMatch(/claude/i)
    for (const titulo of ['Suporte Remoto', 'Chave da Equipe', 'Seu Nome', 'Link para o Cliente']) {
      expect(container.textContent).toContain(titulo)
    }
  })

  it('onde o suporte não existe (app do celular), a seção não aparece', () => {
    ;(window as unknown as { api: unknown }).api = {}
    const { container } = render(
      <UiProvider>
        <SuporteRemotoSection />
      </UiProvider>
    )
    expect(container.querySelector('.suporte-secao')).toBeNull()
  })
})
