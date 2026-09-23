import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, dialog: {} }))

const { exportFlowPdf, pdfFileName } = await import('./flowPdfExport')

describe('flowPdfExport', () => {
  it('nome do arquivo: tira o que o Windows recusa e nunca fica vazio', () => {
    expect(pdfFileName('Plano: fase 1/2 <final>?')).toBe('Plano fase 1 2 final')
    expect(pdfFileName('  ... ')).toBe('planejamento')
    expect(pdfFileName('Decisão do Banco.')).toBe('Decisão do Banco')
  })

  it('pedido inválido é recusado antes de abrir qualquer diálogo', async () => {
    const res = await exportFlowPdf({} as never, { html: '<p/>', width: 50_000, height: 10, name: 'x' })
    expect(res).toEqual({ ok: false, message: 'Pedido de exportação inválido.' })
  })
})
