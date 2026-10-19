import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TarefaRodada, TarefaVista } from '@shared/tarefas'
import { UiProvider } from '../../ui/UiProvider'
import { TarefasBolinha, type TarefaAcaoFn } from './TarefasBolinha'
import { TarefaSelo } from './TarefaSelo'
import { resumoDaConversa } from '@shared/tarefas'

afterEach(cleanup)

const AGORA = Date.parse('2026-10-19T17:15:00Z') // 14:15 em São Paulo

function tarefa(over: Partial<TarefaVista> = {}): TarefaVista {
  return {
    id: 't1',
    tipo: 'monitor',
    titulo: 'Passagem RJ → Lisboa < R$ 3.000',
    mensagem: null,
    convId: 'c1',
    cwd: 'C:/x',
    agenda: { tipo: 'intervalo', intervaloMin: 10 },
    estado: 'ativa',
    modelo: 'claude-haiku-5-5',
    condicao: 'ida e volta em março abaixo de R$ 3.000',
    combinado: 'só pesquisa na web',
    criadaPor: 'pc-a',
    criadaEm: '2026-10-19T14:00:00Z',
    atualizadaEm: '2026-10-19T17:10:00Z',
    proximaEm: '2026-10-19T17:20:00Z',
    ultimaEm: '2026-10-19T17:10:00Z',
    ultimoResultado: 'nao-bateu',
    ultimoValor: 'R$ 3.180',
    avisadoValor: null,
    falhasSeguidas: 0,
    bateuNaoVistoEm: null,
    rodando: false,
    rodadas: [],
    ...over
  }
}

function rodada(i: number, over: Partial<TarefaRodada> = {}): TarefaRodada {
  const inicio = new Date(AGORA - (i + 1) * 10 * 60_000).toISOString()
  return { id: `r${i}`, tarefaId: 't1', inicio, fim: inicio, resultado: 'nao-bateu', valor: `R$ ${3000 + i}`, resumo: null, fonte: null, falha: null, instalacao: 'pc-a', ...over }
}

function montar(tarefas: TarefaVista[], acao: TarefaAcaoFn = vi.fn(async () => ({ ok: true as const, valor: null }))) {
  const view = render(
    <UiProvider>
      <div data-testid="fora">fora</div>
      <TarefasBolinha tarefas={tarefas} acao={acao} agora={() => AGORA} />
    </UiProvider>
  )
  const dot = (): HTMLElement => view.container.querySelector<HTMLElement>('.tdot')!
  const pop = (): HTMLElement | null => view.container.querySelector<HTMLElement>('.tpop')
  return { view, dot, pop, acao }
}

describe('bolinha de tarefas — estados', () => {
  it('esperando: coral, sem arco nem número com uma tarefa', () => {
    const { dot } = montar([tarefa()])
    expect(dot().className).toBe('tdot')
    expect(dot().querySelector('.n')).toBeNull()
  })

  it('checando: arco girando; número com mais de uma tarefa', () => {
    const { dot } = montar([tarefa({ rodando: true }), tarefa({ id: 't2' })])
    expect(dot().classList.contains('run')).toBe(true)
    expect(dot().querySelector('.n')?.textContent).toBe('2')
  })

  it('bateu e não visto: verde (hit); pode girar junto', () => {
    const { dot } = montar([tarefa({ bateuNaoVistoEm: '2026-10-19T17:10:00Z', ultimoResultado: 'bateu' }), tarefa({ id: 't2', rodando: true })])
    expect(dot().classList.contains('hit')).toBe(true)
    expect(dot().classList.contains('run')).toBe(true)
  })

  it('só lembrete: âmbar; tudo pausado: cinza', () => {
    const lembrete = montar([tarefa({ tipo: 'lembrete', agenda: { tipo: 'uma-vez', quando: '2026-10-20T12:00:00Z' } })])
    expect(lembrete.dot().classList.contains('rem')).toBe(true)
    cleanup()
    const pausado = montar([tarefa({ estado: 'pausada' })])
    expect(pausado.dot().classList.contains('paused')).toBe(true)
  })

  it('sem tarefa: não aparece', () => {
    const { view } = montar([])
    expect(view.container.querySelector('.tdot')).toBeNull()
  })
})

describe('bolinha de tarefas — popover', () => {
  it('clique abre; Esc fecha; clique fora fecha; clique dentro não fecha', () => {
    const { dot, pop } = montar([tarefa()])
    fireEvent.click(dot())
    expect(pop()).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(pop()).toBeNull()

    fireEvent.click(dot())
    fireEvent.pointerDown(pop()!.querySelector('.tpop-h')!)
    expect(pop()).not.toBeNull()
    fireEvent.pointerDown(screen.getByTestId('fora'))
    expect(pop()).toBeNull()
  })

  it('abrir marca o "bateu" como visto (só o das não vistas)', async () => {
    const acao = vi.fn<TarefaAcaoFn>(async () => ({ ok: true, valor: null }))
    const { dot } = montar([tarefa({ bateuNaoVistoEm: '2026-10-19T17:10:00Z', ultimoResultado: 'bateu' }), tarefa({ id: 't2' })], acao)
    expect(acao).not.toHaveBeenCalled()
    fireEvent.click(dot())
    await waitFor(() => expect(acao).toHaveBeenCalledWith('t1', 'visto'))
    expect(acao).toHaveBeenCalledTimes(1)
  })

  it('lista frequência, próxima e último resultado; abrir mostra as 10 últimas, o combinado e Pausar', async () => {
    const acao = vi.fn<TarefaAcaoFn>(async () => ({ ok: true, valor: null }))
    const rodadas = Array.from({ length: 10 }, (_, i) => rodada(i, i === 0 ? { resultado: 'falha', falha: 'captcha no site', valor: null } : {}))
    const { dot, pop } = montar([tarefa({ rodadas })], acao)
    fireEvent.click(dot())
    expect(pop()!.querySelector('.tmeta')?.textContent).toBe('a cada 10 min · próxima 14:20 · último R$ 3.180')
    fireEvent.click(pop()!.querySelector('button.trow')!)
    const itens = pop()!.querySelectorAll('.runs li')
    expect(itens).toHaveLength(10)
    expect(itens[0].textContent).toContain('falhou: captcha no site')
    expect(itens[0].querySelector('.st')?.className).toBe('st err')
    expect(pop()!.querySelector('.combo')?.textContent).toBe('Próxima 14:20 · modelo Haiku · combinado: só pesquisa na web')
    fireEvent.click(screen.getByRole('button', { name: /Pausar/ }))
    await waitFor(() => expect(acao).toHaveBeenCalledWith('t1', 'pausar'))
  })

  it('pausada mostra Retomar', async () => {
    const acao = vi.fn<TarefaAcaoFn>(async () => ({ ok: true, valor: null }))
    const { dot, pop } = montar([tarefa({ estado: 'pausada' })], acao)
    fireEvent.click(dot())
    fireEvent.click(pop()!.querySelector('button.trow')!)
    fireEvent.click(screen.getByRole('button', { name: /Retomar/ }))
    await waitFor(() => expect(acao).toHaveBeenCalledWith('t1', 'retomar'))
  })

  it('Cancelar pede o modal (botão vermelho): Voltar não cancela e mantém o popover; confirmar cancela', async () => {
    const acao = vi.fn<TarefaAcaoFn>(async () => ({ ok: true, valor: null }))
    const { dot, pop } = montar([tarefa()], acao)
    fireEvent.click(dot())
    fireEvent.click(pop()!.querySelector('button.trow')!)
    fireEvent.click(screen.getByRole('button', { name: /^Cancelar$/ }))
    expect(await screen.findByText('Cancelar a tarefa?')).toBeTruthy()
    const vermelho = screen.getByRole('button', { name: 'Cancelar tarefa' })
    expect(vermelho.className).toContain('danger-btn')

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Voltar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }))
    await waitFor(() => expect(screen.queryByText('Cancelar a tarefa?')).toBeNull())
    expect(acao).not.toHaveBeenCalledWith('t1', 'cancelar')
    expect(pop()).not.toBeNull()

    await act(async () => new Promise((r) => setTimeout(r, 5)))
    fireEvent.click(screen.getByRole('button', { name: /^Cancelar$/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar tarefa' }))
    await waitFor(() => expect(acao).toHaveBeenCalledWith('t1', 'cancelar'))
  })

  it('lembrete: só o X de cancelar, que também pede o modal', async () => {
    const acao = vi.fn<TarefaAcaoFn>(async () => ({ ok: true, valor: null }))
    const { dot, pop } = montar([tarefa({ tipo: 'lembrete', agenda: { tipo: 'uma-vez', quando: '2026-10-20T12:00:00Z' }, proximaEm: '2026-10-20T12:00:00Z' })], acao)
    fireEvent.click(dot())
    expect(pop()!.querySelector('button.trow')).toBeNull()
    expect(pop()!.querySelector('.tmeta')?.textContent).toBe('20/10 09:00 · em 18 h 45 min')
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar lembrete' }))
    expect(await screen.findByText('Cancelar o lembrete?')).toBeTruthy()
    fireEvent.click(document.querySelector<HTMLElement>('.danger-btn')!)
    await waitFor(() => expect(acao).toHaveBeenCalledWith('t1', 'cancelar'))
  })

  it('ação recusada pelo main vira toast de erro', async () => {
    const acao = vi.fn<TarefaAcaoFn>(async () => ({ ok: false, erro: 'a tarefa já está pausada' }))
    const { dot, pop } = montar([tarefa()], acao)
    fireEvent.click(dot())
    fireEvent.click(pop()!.querySelector('button.trow')!)
    fireEvent.click(screen.getByRole('button', { name: /Pausar/ }))
    expect(await screen.findByText('a tarefa já está pausada')).toBeTruthy()
  })
})

describe('selo da lista de conversas', () => {
  it('ícone + número; ponto pulsando checando; verde quando bateu', () => {
    const lista = [tarefa({ rodando: true }), tarefa({ id: 't2' })]
    const { container, rerender } = render(<TarefaSelo resumo={resumoDaConversa('c1', lista)} />)
    const selo = container.querySelector('.tselo')!
    expect(selo.textContent).toBe('2')
    expect(selo.querySelector('svg')).not.toBeNull()
    expect(selo.querySelector('.live')).not.toBeNull()
    rerender(<TarefaSelo resumo={resumoDaConversa('c1', [tarefa({ bateuNaoVistoEm: 'x', ultimoResultado: 'bateu' })])} />)
    expect(container.querySelector('.tselo')!.className).toBe('tselo hit')
    expect(container.querySelector('.tselo .live')).toBeNull()
    rerender(<TarefaSelo resumo={null} />)
    expect(container.querySelector('.tselo')).toBeNull()
  })
})

describe('posição (mockup)', () => {
  const css = readFileSync(join(__dirname, 'tarefas.css'), 'utf8')
  it('com tarefas, o "ir para o final" sobe acima da bolinha e a lista ganha folga (PC e celular)', () => {
    expect(css).toMatch(/\.message-list-wrap\.com-tarefas \.jump-bottom \{ bottom: 58px; \}/)
    expect(css).toMatch(/\.message-list-wrap\.com-tarefas \.message-list \{ padding-bottom: 58px; \}/)
    expect(css).toMatch(/\.messages-wrap\.com-tarefas \.jump-bottom \{ bottom: 66px; \}/)
    expect(css).toMatch(/\.messages-wrap\.com-tarefas \.messages \{ padding-bottom: 64px; \}/)
  })
  it('PC 34 px, celular 42 px', () => {
    expect(css).toMatch(/\.tdot \{[^}]*width: 34px;[^}]*height: 34px;/)
    expect(css).toMatch(/\.tdot\.celular \{ width: 42px; height: 42px;/)
  })
})
