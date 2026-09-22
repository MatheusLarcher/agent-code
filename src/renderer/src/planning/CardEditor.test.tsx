import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PlanningCardDto } from '@shared/ipc'
import { UiProvider } from '../ui/UiProvider'
import { CardEditor, makeCardId } from './CardEditor'
import { usePlanning } from './usePlanning'
import { CWD, SLUG, makeCard, mockPlanningApi } from './planningTestUtils'

afterEach(cleanup)

const ETAPAS = [
  { id: 'requisitos', titulo: 'Levantar requisitos' },
  { id: 'desenho', titulo: 'Desenhar a solução' }
]

/** Editor ligado ao hook de verdade: o Salvar tem que chegar ao IPC. */
function Wired({ id }: { id: string }): JSX.Element | null {
  const { plan, saveCard } = usePlanning(CWD, SLUG)
  const card = plan?.cards.find((c) => c.id === id)
  if (!plan || !card) return null
  return <CardEditor card={card} isNew={false} etapas={plan.roteiro.etapas} existingIds={[]} onSave={saveCard} onCancel={vi.fn()} />
}

function renderEditor(card: PlanningCardDto, over: Partial<Parameters<typeof CardEditor>[0]> = {}) {
  const onSave = vi.fn()
  const utils = render(
    <CardEditor card={card} isNew={false} etapas={ETAPAS} existingIds={[]} onSave={onSave} onCancel={vi.fn()} {...over} />
  )
  return { ...utils, onSave }
}

describe('CardEditor', () => {
  it('salvar chama planningSaveCard com o expectedRev do card aberto', async () => {
    const { api } = mockPlanningApi()
    render(
      <UiProvider>
        <Wired id="login" />
      </UiProvider>
    )
    const titulo = await screen.findByLabelText('Título')
    fireEvent.change(titulo, { target: { value: 'Login com SSO e MFA' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(api.planningSaveCard).toHaveBeenCalledTimes(1))
    expect(api.planningSaveCard).toHaveBeenCalledWith({
      projectCwd: CWD,
      slug: SLUG,
      expectedRev: 4,
      card: expect.objectContaining({ id: 'login', titulo: 'Login com SSO e MFA', etapa: 'requisitos', rev: 4 })
    })
  })

  it('o expectedRev fica congelado no rev da abertura, mesmo se o card mudar por fora', () => {
    const card = makeCard('login', { rev: 4 })
    const { rerender, onSave } = renderEditor(card)
    rerender(<CardEditor card={{ ...card, rev: 9 }} isNew={false} etapas={ETAPAS} existingIds={[]} onSave={onSave} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'login' }), 4)
  })

  it('edita tipo, etapa e corpo', () => {
    const { onSave } = renderEditor(makeCard('x', { rev: 2 }))
    fireEvent.click(screen.getByRole('radio', { name: /Decisão/ }))
    fireEvent.change(screen.getByLabelText('Etapa'), { target: { value: 'desenho' } })
    fireEvent.change(screen.getByLabelText('Conteúdo'), { target: { value: 'Porque sim' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'decisao', etapa: 'desenho', corpo: 'Porque sim' }), 2)
  })

  it('sugestão exige fonte http(s): sem ela não salva e explica', () => {
    const { onSave } = renderEditor(makeCard('x'))
    fireEvent.click(screen.getByRole('radio', { name: /Sugestão/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(screen.getByRole('alert').textContent).toMatch(/fonte/)
    expect(onSave).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Fonte'), { target: { value: 'https://exemplo.com/artigo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'sugestao', fonte: 'https://exemplo.com/artigo' }), 1)
  })

  it('ambiguidade grava o selo aberta/resolvida', () => {
    const { onSave } = renderEditor(makeCard('d', { tipo: 'ambiguidade', status: 'aberta' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Resolvida' }))
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'ambiguidade', status: 'resolvida' }), 1)
  })

  it('título vazio não salva', () => {
    const { onSave } = renderEditor(makeCard('x'))
    fireEvent.change(screen.getByLabelText('Título'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('card novo ganha id a partir do título e expectedRev 0; não mostra Apagar', () => {
    const blank = { id: '', tipo: 'nota' as const, titulo: '', links: [], rev: 0, corpo: '' }
    const onDelete = vi.fn()
    const { onSave } = renderEditor(blank, { isNew: true, existingIds: ['decisao-de-api'], onDelete })
    expect(screen.queryByRole('button', { name: 'Apagar' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'Decisão de API' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'decisao-de-api-2', titulo: 'Decisão de API' }), 0)
  })

  it('Apagar e Cancelar chamam quem abriu o editor', () => {
    const onDelete = vi.fn()
    const onCancel = vi.fn()
    const card = makeCard('x')
    renderEditor(card, { onDelete, onCancel })
    fireEvent.click(screen.getByRole('button', { name: 'Apagar' }))
    expect(onDelete).toHaveBeenCalledWith(card)
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('a prévia renderiza o markdown com o componente do app', () => {
    renderEditor(makeCard('x', { corpo: '# Título grande\n\n- item um' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Prévia' }))
    expect(screen.getByRole('heading', { name: 'Título grande' })).toBeTruthy()
    expect(document.querySelector('.pl-preview .md')).toBeTruthy()
  })
})

describe('makeCardId', () => {
  it('gera [a-z0-9-] sem acento e sem colidir', () => {
    expect(makeCardId('Ação: Decidir o BANCO!', [])).toBe('acao-decidir-o-banco')
    expect(makeCardId('x', ['x', 'x-2'])).toBe('x-3')
    expect(makeCardId('!!!', [])).toBe('card')
    expect(makeCardId('a'.repeat(100), [])).toMatch(/^[a-z0-9-]{1,64}$/)
  })
})
