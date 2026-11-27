import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PreviewSheet } from '@shared/preview'
import { TableView } from './TableView'

afterEach(cleanup)

/** Texto da coluna `col` (sem contar a do número da linha) em cada linha visível. */
function column(container: HTMLElement, col: number): string[] {
  return Array.from(container.querySelectorAll('tbody tr')).map((tr) => tr.children[col + 1].textContent ?? '')
}

const sheet = (rows: string[][], name = 'Plan1', truncated = false): PreviewSheet => ({ name, rows, truncated })

describe('TableView', () => {
  const data = sheet([
    ['Nome', 'Valor'],
    ['Banana', '1.234,56'],
    ['ábaco', '9,5'],
    ['Caju', '100'],
    ['Abacate', '']
  ])

  it('ordena número pt-BR pelo cabeçalho: crescente → decrescente → original', () => {
    const { container } = render(<TableView sheets={[data]} />)
    const valor = screen.getByTitle('Ordenar por Valor')
    expect(container.querySelector('td.num')).not.toBeNull()

    fireEvent.click(valor)
    expect(column(container, 1)).toEqual(['9,5', '100', '1.234,56', ''])
    expect(valor.closest('th')?.getAttribute('aria-sort')).toBe('ascending')

    fireEvent.click(valor)
    expect(column(container, 1)).toEqual(['1.234,56', '100', '9,5', ''])

    fireEvent.click(valor)
    expect(column(container, 1)).toEqual(['1.234,56', '9,5', '100', ''])
    expect(valor.closest('th')?.getAttribute('aria-sort')).toBe('none')
  })

  it('ordena texto sem diferenciar acento e maiúscula', () => {
    const { container } = render(<TableView sheets={[data]} />)
    fireEvent.click(screen.getByTitle('Ordenar por Nome'))
    expect(column(container, 0)).toEqual(['Abacate', 'ábaco', 'Banana', 'Caju'])
  })

  it('filtra em todas as colunas e mostra a contagem', () => {
    const { container } = render(<TableView sheets={[data]} />)
    expect(screen.getByText('4 linhas')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Filtrar linhas'), { target: { value: 'ABACO' } })
    expect(column(container, 0)).toEqual(['ábaco'])
    expect(screen.getByText('1 de 4 linhas')).toBeTruthy()
    // O número da linha segue a origem (cabeçalho = linha 1).
    expect(container.querySelector('tbody td.pv-rownum')?.textContent).toBe('3')

    fireEvent.change(screen.getByLabelText('Filtrar linhas'), { target: { value: 'zzz' } })
    expect(screen.getByText('Nenhuma linha com esse texto.')).toBeTruthy()
  })

  it('pagina de 100 em 100 e só desenha a página atual', () => {
    const rows = [['n'], ...Array.from({ length: 250 }, (_, i) => [String(i + 1)])]
    const { container } = render(<TableView sheets={[sheet(rows)]} />)
    expect(container.querySelectorAll('tbody tr')).toHaveLength(100)
    expect(screen.getByText('Página 1 de 3')).toBeTruthy()
    const prev = screen.getByRole('button', { name: /Anterior/ }) as HTMLButtonElement
    const next = screen.getByRole('button', { name: /Próxima/ }) as HTMLButtonElement
    expect(prev.disabled).toBe(true)

    fireEvent.click(next)
    fireEvent.click(next)
    expect(screen.getByText('Página 3 de 3')).toBeTruthy()
    expect(container.querySelectorAll('tbody tr')).toHaveLength(50)
    expect(column(container, 0)[0]).toBe('201')
    expect(next.disabled).toBe(true)

    // Filtrar volta para a 1ª página.
    fireEvent.change(screen.getByLabelText('Filtrar linhas'), { target: { value: '1' } })
    expect(screen.getByText(/^Página 1 de/)).toBeTruthy()
  })

  it('sem paginação quando cabe numa página', () => {
    render(<TableView sheets={[data]} />)
    expect(screen.queryByText(/Página/)).toBeNull()
  })

  it('troca de aba e zera o filtro; uma aba só não mostra abas', () => {
    const a = sheet([['x'], ['um'], ['dois']], 'Vendas')
    const b = sheet([['y'], ['três']], 'Custos')
    const { container, rerender } = render(<TableView sheets={[a, b]} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Vendas', 'Custos'])
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')

    fireEvent.change(screen.getByLabelText('Filtrar linhas'), { target: { value: 'dois' } })
    expect(column(container, 0)).toEqual(['dois'])

    fireEvent.click(tabs[1])
    expect(screen.getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true')
    expect(column(container, 0)).toEqual(['três'])
    expect((screen.getByLabelText('Filtrar linhas') as HTMLInputElement).value).toBe('')

    rerender(<TableView sheets={[a]} />)
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('avisa quando a aba foi cortada', () => {
    render(<TableView sheets={[sheet([['a'], ['1']], 'P', true)]} />)
    expect(screen.getByRole('status').textContent).toContain('5.000 linhas')
  })

  it('aba vazia e só cabeçalho', () => {
    render(<TableView sheets={[sheet([])]} />)
    expect(screen.getByText('Esta aba está vazia.')).toBeTruthy()
    cleanup()
    render(<TableView sheets={[sheet([['a', 'b']])]} />)
    expect(screen.getByText('Só o cabeçalho, sem linhas.')).toBeTruthy()
  })
})
