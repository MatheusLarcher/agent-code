// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SuporteAjustes, SuporteStatus } from '@shared/suporteRemoto'
import { UiProvider } from '../ui/UiProvider'
import { SuporteRemotoAvisos } from './SuporteRemotoAvisos'
import { SuporteRemotoFaixa } from './SuporteRemotoFaixa'

const LIGADO: SuporteAjustes = { ativado: true, tecnico: 'Ana', temChave: true }
const SEM_SESSAO: SuporteStatus = { estado: 'desligado', convId: null }

function instalarApi(ajustes: SuporteAjustes, status: SuporteStatus = SEM_SESSAO) {
  let emitirStatus: (s: SuporteStatus) => void = () => undefined
  let emitirAjustes: (a: SuporteAjustes) => void = () => undefined
  const api = {
    getSuporteAjustes: vi.fn(async () => ajustes),
    getSuporteStatus: vi.fn(async () => status),
    onSuporteAjustesMudou: vi.fn((cb: (a: SuporteAjustes) => void) => {
      emitirAjustes = cb
      return () => undefined
    }),
    onSuporteStatusMudou: vi.fn((cb: (s: SuporteStatus) => void) => {
      emitirStatus = cb
      return () => undefined
    }),
    conectarSuporte: vi.fn(async (): Promise<{ ok: boolean; mensagem?: string; avisado?: boolean }> => ({ ok: true })),
    desconectarSuporte: vi.fn(async () => true)
  }
  ;(window as unknown as { api: unknown }).api = api
  return {
    api,
    status: (s: SuporteStatus) => act(() => emitirStatus(s)),
    ajustes: (a: SuporteAjustes) => act(() => emitirAjustes(a))
  }
}

const mostrar = (convId = 'conv-a') => render(<SuporteRemotoFaixa convId={convId} />)
const faixa = (): HTMLElement | null => document.querySelector('.suporte-faixa')

afterEach(cleanup)

describe('SuporteRemotoFaixa — quando aparece', () => {
  it('recurso desligado: nada na conversa', async () => {
    const { api } = instalarApi({ ativado: false, tecnico: '', temChave: false })
    mostrar()
    await waitFor(() => expect(api.getSuporteAjustes).toHaveBeenCalled())
    expect(faixa()).toBeNull()
  })

  it('ligar em Configurações faz a faixa aparecer sem recarregar', async () => {
    const tela = instalarApi({ ativado: false, tecnico: '', temChave: true })
    mostrar()
    await waitFor(() => expect(tela.api.onSuporteAjustesMudou).toHaveBeenCalled())
    tela.ajustes(LIGADO)
    expect(await screen.findByLabelText('Código do cliente')).toBeTruthy()
  })

  it('sessão de outra conversa: esta não mostra nada', async () => {
    instalarApi(LIGADO, { estado: 'conectado', convId: 'conv-b', pc: 'PC-DA-MARIA' })
    mostrar('conv-a')
    await waitFor(() => expect((window as unknown as { api: { getSuporteStatus: ReturnType<typeof vi.fn> } }).api.getSuporteStatus).toHaveBeenCalled())
    expect(faixa()).toBeNull()
  })

  it('onde o suporte não existe (app do celular), não quebra nem aparece', () => {
    ;(window as unknown as { api: unknown }).api = {}
    mostrar()
    expect(faixa()).toBeNull()
  })
})

describe('SuporteRemotoFaixa — cada estado', () => {
  it('sem sessão: campo do código em grupos de três e botão Conectar', async () => {
    const { api } = instalarApi(LIGADO)
    mostrar()
    const campo = (await screen.findByLabelText('Código do cliente')) as HTMLInputElement
    expect(faixa()?.getAttribute('data-estado')).toBe('desligado')
    fireEvent.change(campo, { target: { value: '482-917.305 99x' } })
    expect(campo.value).toBe('482 917 305')
    fireEvent.click(screen.getByRole('button', { name: 'Conectar' }))
    await waitFor(() => expect(api.conectarSuporte).toHaveBeenCalledWith('conv-a', '482917305'))
  })

  it('código incompleto não vai ao main: erro ao lado do campo, foco de volta nele', async () => {
    const { api } = instalarApi(LIGADO)
    mostrar()
    const campo = (await screen.findByLabelText('Código do cliente')) as HTMLInputElement
    fireEvent.change(campo, { target: { value: '4829' } })
    fireEvent.click(screen.getByRole('button', { name: 'Conectar' }))
    expect((await screen.findByRole('alert')).textContent).toBe('O código tem 9 dígitos.')
    expect(api.conectarSuporte).not.toHaveBeenCalled()
    expect(campo.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(campo)
  })

  it('falha ao conectar aparece na faixa; recusa do cliente fica só no toast', async () => {
    const { api } = instalarApi(LIGADO)
    mostrar()
    const campo = (await screen.findByLabelText('Código do cliente')) as HTMLInputElement
    fireEvent.change(campo, { target: { value: '482917305' } })
    api.conectarSuporte.mockResolvedValueOnce({ ok: false, mensagem: 'Nenhum cliente com esse código.' })
    fireEvent.click(screen.getByRole('button', { name: 'Conectar' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Nenhum cliente com esse código.')
    // O código continua no campo para corrigir.
    expect(campo.value).toBe('482 917 305')

    api.conectarSuporte.mockResolvedValueOnce({ ok: false, mensagem: 'O cliente não permitiu o acesso.', avisado: true })
    fireEvent.click(screen.getByRole('button', { name: 'Conectar' }))
    await waitFor(() => expect(api.conectarSuporte).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('conectando e aguardando: texto do estado e Cancelar', async () => {
    const tela = instalarApi(LIGADO)
    mostrar()
    await screen.findByLabelText('Código do cliente')
    tela.status({ estado: 'conectando', convId: 'conv-a' })
    expect(screen.getByText('Conectando…')).toBeTruthy()
    expect(screen.queryByLabelText('Código do cliente')).toBeNull()
    tela.status({ estado: 'aguardando', convId: 'conv-a' })
    expect(screen.getByText('Aguardando o cliente permitir…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    await waitFor(() => expect(tela.api.desconectarSuporte).toHaveBeenCalledTimes(1))
  })

  it('conectado: nome do computador, o que foi liberado, e Encerrar chama desconectar', async () => {
    const tela = instalarApi(LIGADO, {
      estado: 'conectado',
      convId: 'conv-a',
      pc: 'PC-DA-MARIA',
      admin: true,
      recursos: { chrome: 'ligado', celular: 'travado', tela: 'ligado' }
    })
    mostrar()
    expect(await screen.findByText('PC-DA-MARIA')).toBeTruthy()
    expect(faixa()?.getAttribute('data-estado')).toBe('conectado')
    expect(screen.getByText('Administrador')).toBeTruthy()
    expect(screen.getByText('Chrome')).toBeTruthy()
    expect(screen.queryByText('Celular')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Encerrar' }))
    await waitFor(() => expect(tela.api.desconectarSuporte).toHaveBeenCalledTimes(1))
  })

  it('caiu: avisa, deixa conectar de novo com outro código e dispensar', async () => {
    const tela = instalarApi(LIGADO, { estado: 'caiu', convId: 'conv-a', aviso: { n: 1, tipo: 'caiu', texto: 'A conexão com o computador do cliente caiu.' } })
    mostrar()
    expect(await screen.findByText('A conexão com o cliente caiu.')).toBeTruthy()
    expect(faixa()?.getAttribute('data-estado')).toBe('caiu')
    expect(screen.getByLabelText('Código do cliente')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dispensar' }))
    await waitFor(() => expect(tela.api.desconectarSuporte).toHaveBeenCalledTimes(1))
  })

  it('texto visível nunca cita "Claude"', async () => {
    const tela = instalarApi(LIGADO)
    const { container } = mostrar()
    await screen.findByLabelText('Código do cliente')
    for (const status of [SEM_SESSAO, { estado: 'aguardando', convId: 'conv-a' }, { estado: 'conectado', convId: 'conv-a', pc: 'PC' }, { estado: 'caiu', convId: 'conv-a' }] as SuporteStatus[]) {
      tela.status(status)
      expect(container.textContent).not.toMatch(/claude/i)
    }
  })
})

describe('SuporteRemotoAvisos — toasts', () => {
  const comAvisos = () =>
    render(
      <UiProvider>
        <SuporteRemotoAvisos />
      </UiProvider>
    )

  it('conectou, o cliente recusou, o cliente encerrou e a sessão caiu: um toast cada', async () => {
    const tela = instalarApi(LIGADO)
    comAvisos()
    await waitFor(() => expect(tela.api.onSuporteStatusMudou).toHaveBeenCalled())
    await waitFor(() => expect(tela.api.getSuporteStatus).toHaveBeenCalled())

    tela.status({ estado: 'conectado', convId: 'conv-a', pc: 'PC-DA-MARIA' })
    expect(await screen.findByText('Conectado ao computador PC-DA-MARIA.')).toBeTruthy()

    tela.status({ estado: 'caiu', convId: 'conv-a', aviso: { n: 1, tipo: 'caiu', texto: 'A conexão com o computador do cliente caiu.' } })
    expect(await screen.findByText('A conexão com o computador do cliente caiu.')).toBeTruthy()

    tela.status({ estado: 'desligado', convId: null, aviso: { n: 2, tipo: 'recusado', texto: 'O cliente não permitiu o acesso (ou não respondeu em 1 minuto).' } })
    expect(await screen.findByText(/O cliente não permitiu o acesso/)).toBeTruthy()

    tela.status({ estado: 'desligado', convId: null, aviso: { n: 3, tipo: 'encerrado', texto: 'O cliente encerrou a sessão de suporte.' } })
    expect(await screen.findByText('O cliente encerrou a sessão de suporte.')).toBeTruthy()
  })

  it('o mesmo aviso não repete, erro de código não vira toast e o estado de quando a tela abriu não é novidade', async () => {
    const aviso = { n: 7, tipo: 'caiu' as const, texto: 'A conexão com o computador do cliente caiu.' }
    const tela = instalarApi(LIGADO, { estado: 'caiu', convId: 'conv-a', aviso })
    comAvisos()
    await waitFor(() => expect(tela.api.getSuporteStatus).toHaveBeenCalled())
    await act(async () => undefined)
    expect(screen.queryByText(aviso.texto)).toBeNull()
    // Reenvio do mesmo estado (ex.: recurso mudou): nada de toast.
    tela.status({ estado: 'caiu', convId: 'conv-a', aviso })
    expect(screen.queryByText(aviso.texto)).toBeNull()
    tela.status({ estado: 'desligado', convId: null, aviso: { n: 8, tipo: 'erro', texto: 'Nenhum cliente com esse código.' } })
    expect(screen.queryByText('Nenhum cliente com esse código.')).toBeNull()
  })
})
