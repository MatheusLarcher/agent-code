import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { PlanningCardDto, PlanMediaDto } from '@shared/ipc'
import { CardEditor, type CardEditorProps } from './CardEditor'
import type { SaveCardOutcome } from './usePlanning'
import { CWD, SLUG, makeCard } from './planningTestUtils'

beforeEach(() => localStorage.clear())
afterEach(async () => {
  cleanup()
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5))
  })
})

const MEDIA: PlanMediaDto[] = [
  { name: 'a1b2c3-tela.png', path: 'D:\\dados\\plano\\midia\\a1b2c3-tela.png', kind: 'imagem', size: 2048, mediaType: 'image/png' },
  { name: 'd4e5f6-fluxo.pdf', path: 'D:\\dados\\plano\\midia\\d4e5f6-fluxo.pdf', kind: 'pdf', size: 3 * 1024 * 1024, mediaType: 'application/pdf' }
]

function okSave() {
  return vi.fn(async (card: PlanningCardDto, rev: number): Promise<SaveCardOutcome> => ({ ok: true, card: { ...card, rev: rev + 1 } }))
}

function renderEditor(card: PlanningCardDto, over: Partial<CardEditorProps> = {}) {
  const p: CardEditorProps = {
    card,
    isNew: false,
    etapas: [],
    existingIds: [],
    projectCwd: CWD,
    slug: SLUG,
    onSave: okSave(),
    onClose: vi.fn(),
    media: MEDIA,
    ...over
  }
  render(<CardEditor {...p} />)
  return { onSave: p.onSave as ReturnType<typeof okSave> }
}

const clickOutside = (): void => {
  fireEvent.focusOut(screen.getByLabelText('Título'), { relatedTarget: null })
}

describe('CardEditor — seção Anexos', () => {
  it('lista cada anexo com tipo e tamanho; o que sumiu de midia/ avisa e não tem Abrir', () => {
    const onOpenMedia = vi.fn()
    renderEditor(makeCard('x', { anexos: ['a1b2c3-tela.png', 'd4e5f6-fluxo.pdf', 'ffffff-sumiu.mp4'] }), { onOpenMedia })
    expect(screen.getByText('Anexos (3)')).toBeTruthy()
    const pdf = screen.getByTestId('pl-anexo-d4e5f6-fluxo.pdf')
    expect(within(pdf).getByText('fluxo.pdf')).toBeTruthy()
    expect(within(pdf).getByText('PDF · 3,0 MB')).toBeTruthy()
    fireEvent.click(within(pdf).getByRole('button', { name: 'Abrir' }))
    expect(onOpenMedia).toHaveBeenCalledWith('d4e5f6-fluxo.pdf')
    const gone = screen.getByTestId('pl-anexo-ffffff-sumiu.mp4')
    expect(within(gone).getByText(/Não está mais na pasta midia/)).toBeTruthy()
    expect(within(gone).queryByRole('button', { name: 'Abrir' })).toBeNull()
  })

  it('Remover tira do card e a gravação vai sem o anexo', async () => {
    const { onSave } = renderEditor(makeCard('x', { rev: 3, anexos: ['a1b2c3-tela.png', 'd4e5f6-fluxo.pdf'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Remover tela.png do card' }))
    expect(screen.queryByTestId('pl-anexo-a1b2c3-tela.png')).toBeNull()
    clickOutside()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].anexos).toEqual(['d4e5f6-fluxo.pdf'])
    expect(onSave.mock.calls[0][1]).toBe(3)
  })

  it('card de mídia sem anexo não grava e diz o motivo', async () => {
    const { onSave } = renderEditor(makeCard('x', { tipo: 'midia', anexos: ['a1b2c3-tela.png'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Remover tela.png do card' }))
    clickOutside()
    expect(await screen.findByText(/Card de mídia precisa de pelo menos um anexo/)).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('"Anexar arquivo…" importa pelo seletor, põe o nome no card e grava na hora', async () => {
    const imported: PlanMediaDto = { ...MEDIA[1] }
    const onImportMedia = vi.fn(async () => [imported])
    const { onSave } = renderEditor(makeCard('x', { rev: 2 }), { onImportMedia })
    const input = screen.getByLabelText('Escolher arquivos para anexar') as HTMLInputElement
    const f = new File(['%PDF'], 'Fluxo.pdf', { type: 'application/pdf' })
    fireEvent.change(input, { target: { files: [f] } })
    await waitFor(() => expect(onImportMedia).toHaveBeenCalledWith([f]))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0]).toMatchObject({ id: 'x', anexos: ['d4e5f6-fluxo.pdf'] })
    expect(screen.getByTestId('pl-anexo-d4e5f6-fluxo.pdf')).toBeTruthy()
  })

  it('importação que falhou não muda o card; sem onImportMedia não há botão', async () => {
    const onImportMedia = vi.fn(async () => null)
    const { onSave } = renderEditor(makeCard('x'), { onImportMedia })
    fireEvent.change(screen.getByLabelText('Escolher arquivos para anexar'), {
      target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] }
    })
    await waitFor(() => expect(onImportMedia).toHaveBeenCalled())
    expect(screen.queryByTestId(/pl-anexo-/)).toBeNull()
    expect(onSave).not.toHaveBeenCalled()
    cleanup()
    renderEditor(makeCard('y'))
    expect(screen.queryByRole('button', { name: 'Anexar arquivo…' })).toBeNull()
  })

  it('o tipo Mídia aparece entre os tipos do editor', () => {
    renderEditor(makeCard('x'))
    expect(screen.getByRole('radio', { name: 'Mídia' })).toBeTruthy()
  })
})
