import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PREVIEW_LIMITS } from '@shared/preview'
import { JsonView, jsonToTable, parseJson } from './JsonView'
import * as TableViewModule from './TableView'

afterEach(cleanup)

describe('jsonToTable / parseJson', () => {
  it('lista de objetos: colunas = união das chaves, objeto vira JSON curto', () => {
    const t = jsonToTable([{ a: 1, b: 'x' }, { b: 'y', c: { d: [1, 2] } }, { a: null, e: true }])
    expect(t?.rows).toEqual([
      ['a', 'b', 'c', 'e'],
      ['1', 'x', '', ''],
      ['', 'y', '{"d":[1,2]}', ''],
      ['', '', '', 'true']
    ])
    expect(t?.cutCols).toBe(false)
  })

  it('não é lista de objetos → null', () => {
    expect(jsonToTable([1, 2])).toBeNull()
    expect(jsonToTable([])).toBeNull()
    expect(jsonToTable({ a: 1 })).toBeNull()
    expect(jsonToTable([{ a: 1 }, [1]])).toBeNull()
  })

  it('corta colunas no limite', () => {
    expect(jsonToTable([{ a: 1, b: 2, c: 3 }], 2)).toEqual({ rows: [['a', 'b'], ['1', '2']], cutCols: true, cutRows: false })
  })

  it('corta linhas no limite (as chaves vêm só das linhas que ficaram)', () => {
    expect(jsonToTable([{ a: 1 }, { a: 2 }, { b: 3 }], 200, 2)).toEqual({
      rows: [['a'], ['1'], ['2']],
      cutCols: false,
      cutRows: true
    })
  })

  it('jsonl: um valor por linha; arquivo cortado descarta a última linha quebrada', () => {
    expect(parseJson('{"a":1}\n\n{"a":2}\n', true)).toEqual({ ok: true, value: [{ a: 1 }, { a: 2 }] })
    expect(parseJson('{"a":1}\n{"a":', true)).toEqual({ ok: false })
    expect(parseJson('{"a":1}\n{"a":', true, true)).toEqual({ ok: true, value: [{ a: 1 }] })
    expect(parseJson('{oops}', false)).toEqual({ ok: false })
  })
})

describe('JsonView', () => {
  it('lista de objetos aparece como tabela', () => {
    const { container } = render(<JsonView text='[{"nome":"Ana","idade":30},{"nome":"Bia","idade":4.5}]' />)
    expect(container.querySelector('table.pv-grid')).not.toBeNull()
    expect(Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent)).toEqual(['#', 'nome', 'idade'])
    // JSON usa ponto decimal: a coluna é numérica e a 1ª linha é a 1.
    expect(container.querySelectorAll('tbody td.num')).toHaveLength(2)
    expect(container.querySelector('tbody td.pv-rownum')?.textContent).toBe('1')
  })

  it('lista acima do limite de linhas: corta e avisa', () => {
    const many = Array.from({ length: PREVIEW_LIMITS.tableRows + 3 }, (_, i) => ({ i }))
    render(<JsonView text={JSON.stringify(many)} />)
    expect(screen.getByRole('status').textContent).toContain('passa do limite')
  })

  it('a lista de abas da tabela não muda a cada render (memo)', () => {
    const spy = vi.spyOn(TableViewModule, 'TableView')
    const text = '[{"a":1},{"a":2}]'
    const { rerender } = render(<JsonView text={text} />)
    rerender(<JsonView text={text} />)
    const sheets = spy.mock.calls.map((c) => c[0].sheets)
    expect(sheets.length).toBeGreaterThanOrEqual(2)
    expect(sheets[1]).toBe(sheets[0])
    spy.mockRestore()
  })

  it('jsonl vira tabela', () => {
    const { container } = render(<JsonView text={'{"a":1}\n{"a":2}'} jsonl />)
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2)
  })

  it('objeto aparece como código JSON indentado', () => {
    const { container } = render(<JsonView text='{"a":{"b":1}}' />)
    expect(container.querySelector('table')).toBeNull()
    expect(container.querySelector('.pv-code-text')?.textContent).toBe('{\n  "a": {\n    "b": 1\n  }\n}')
  })

  it('JSON inválido: texto como está, com aviso', () => {
    const { container } = render(<JsonView text='{"a": 1,,}' />)
    expect(screen.getByRole('status').textContent).toContain('Não deu para ler como JSON')
    expect(container.querySelector('.pv-code-text')?.textContent).toBe('{"a": 1,,}')
  })
})
