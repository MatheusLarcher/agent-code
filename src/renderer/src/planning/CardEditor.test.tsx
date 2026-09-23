import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode, useCallback } from 'react'
import type { PlanningCardDto } from '@shared/ipc'
import { UiProvider, useUI } from '../ui/UiProvider'
import { CardEditor, makeCardId, type CardEditorProps } from './CardEditor'
import { GONE_MSG, MERGE_MSG, draftKey, readDraft, writeDraft, fieldsOf } from './cardDraft'
import { usePlanning, type SaveCardOutcome } from './usePlanning'
import { CWD, SLUG, makeCard, mockPlanningApi } from './planningTestUtils'

beforeEach(() => localStorage.clear())
afterEach(async () => {
  cleanup()
  // A gravação do unmount sai num setTimeout: roda aqui, com os mocks deste teste.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5))
  })
})

const ETAPAS = [
  { id: 'requisitos', titulo: 'Levantar requisitos' },
  { id: 'desenho', titulo: 'Desenhar a solução' }
]

/** onSave como o do usePlanning quando o disco aceita: rev = expectedRev + 1. */
function okSave() {
  return vi.fn(async (card: PlanningCardDto, rev: number): Promise<SaveCardOutcome> => ({ ok: true, card: { ...card, rev: rev + 1 } }))
}

function props(card: PlanningCardDto, over: Partial<CardEditorProps> = {}): CardEditorProps {
  return { card, isNew: false, etapas: ETAPAS, existingIds: [], projectCwd: CWD, slug: SLUG, onSave: okSave(), onClose: vi.fn(), ...over }
}

function renderEditor(card: PlanningCardDto, over: Partial<CardEditorProps> = {}) {
  const p = props(card, over)
  const utils = render(<CardEditor {...p} />)
  return { ...utils, onSave: p.onSave as ReturnType<typeof okSave>, onClose: p.onClose as ReturnType<typeof vi.fn>, p }
}

/** O foco sai do painel (clique fora). */
function clickOutside(): void {
  fireEvent.focusOut(screen.getByLabelText('Título'), { relatedTarget: null })
}

const titulo = (): HTMLInputElement => screen.getByLabelText('Título') as HTMLInputElement
const corpo = (): HTMLTextAreaElement => screen.getByLabelText('Conteúdo') as HTMLTextAreaElement

/** Editor ligado ao hook de verdade: a gravação tem que chegar ao IPC. */
function Wired({ id, onClose = vi.fn() }: { id: string; onClose?: () => void }): JSX.Element | null {
  const { plan, saveCard } = usePlanning(CWD, SLUG)
  const { notify } = useUI()
  const save = useCallback((c: PlanningCardDto, rev: number) => saveCard(c, rev, { quietConflict: true }), [saveCard])
  const card = plan?.cards.find((c) => c.id === id)
  if (!plan || !card) return null
  return (
    <CardEditor
      card={card}
      isNew={false}
      etapas={plan.roteiro.etapas}
      existingIds={[]}
      cards={plan.cards}
      projectCwd={CWD}
      slug={SLUG}
      onSave={save}
      onClose={onClose}
      notify={notify}
    />
  )
}

describe('CardEditor — salvamento automático', () => {
  it('não tem botão Salvar; clicar fora grava com o expectedRev do card aberto', async () => {
    const { api } = mockPlanningApi()
    render(
      <UiProvider>
        <Wired id="login" />
      </UiProvider>
    )
    await screen.findByLabelText('Título')
    expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull()
    fireEvent.change(titulo(), { target: { value: 'Login com SSO e MFA' } })
    clickOutside()
    await waitFor(() => expect(api.planningSaveCard).toHaveBeenCalledTimes(1))
    expect(api.planningSaveCard).toHaveBeenCalledWith({
      projectCwd: CWD,
      slug: SLUG,
      expectedRev: 4,
      card: expect.objectContaining({ id: 'login', titulo: 'Login com SSO e MFA', etapa: 'requisitos', rev: 4 })
    })
    // Gravado: o próximo clique fora não grava de novo (nada mudou desde então).
    await waitFor(() => expect(screen.getByText('Gravado')).toBeTruthy())
    clickOutside()
    await act(async () => {})
    expect(api.planningSaveCard).toHaveBeenCalledTimes(1)
  })

  it('nada grava se nada mudou: nem clicando fora, nem fechando', async () => {
    const { onSave, onClose } = renderEditor(makeCard('x'))
    clickOutside()
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onSave).not.toHaveBeenCalled()
  })

  it('Fechar grava e fecha; foco andando dentro do painel não grava', async () => {
    const { onSave, onClose } = renderEditor(makeCard('x', { rev: 2 }))
    fireEvent.change(corpo(), { target: { value: 'Porque sim' } })
    fireEvent.focusOut(titulo(), { relatedTarget: corpo() })
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'x', corpo: 'Porque sim' }), 2)
  })

  it('trocar de card (unmount) grava o que mudou', async () => {
    const { onSave, unmount } = renderEditor(makeCard('x', { rev: 3 }))
    fireEvent.change(titulo(), { target: { value: 'Outro título' } })
    unmount()
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ titulo: 'Outro título' }), 3))
  })

  it('edita tipo, etapa e corpo', async () => {
    const { onSave } = renderEditor(makeCard('x', { rev: 2 }))
    fireEvent.click(screen.getByRole('radio', { name: /Decisão/ }))
    fireEvent.change(screen.getByLabelText('Etapa'), { target: { value: 'desenho' } })
    fireEvent.change(corpo(), { target: { value: 'Porque sim' } })
    clickOutside()
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'decisao', etapa: 'desenho', corpo: 'Porque sim' }), 2)
    )
  })

  it('ambiguidade grava o selo aberta/resolvida', async () => {
    const { onSave } = renderEditor(makeCard('d', { tipo: 'ambiguidade', status: 'aberta' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Resolvida' }))
    clickOutside()
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'ambiguidade', status: 'resolvida' }), 1))
  })

  it('card novo ganha id a partir do título e expectedRev 0; depois grava sobre o rev novo, com o mesmo id', async () => {
    const blank: PlanningCardDto = { id: '', tipo: 'nota', titulo: '', links: [], rev: 0, corpo: '' }
    const onDelete = vi.fn()
    const { onSave } = renderEditor(blank, { isNew: true, existingIds: ['decisao-de-api'], onDelete })
    expect(screen.queryByRole('button', { name: 'Apagar' })).toBeNull()
    fireEvent.change(titulo(), { target: { value: 'Decisão de API' } })
    clickOutside()
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'decisao-de-api-2', titulo: 'Decisão de API' }), 0))
    // Já existe em disco: vira "Editar card", com Apagar.
    expect(await screen.findByRole('dialog', { name: 'Editar card' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Apagar' })).toBeTruthy()
    fireEvent.change(corpo(), { target: { value: 'mais' } })
    clickOutside()
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'decisao-de-api-2', corpo: 'mais' }), 1))
  })

  it('Apagar chama quem abriu o editor com o card, e o × fecha', async () => {
    const onDelete = vi.fn(async () => false)
    const card = makeCard('x')
    const { onClose } = renderEditor(card, { onDelete })
    fireEvent.click(screen.getByRole('button', { name: 'Apagar' }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(card))
    fireEvent.click(screen.getByRole('button', { name: 'Fechar editor' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})

describe('CardEditor — card inválido não vai para o arquivo', () => {
  it('título vazio: não grava, mostra o motivo e mantém no rascunho', async () => {
    const { onSave } = renderEditor(makeCard('x'))
    fireEvent.change(titulo(), { target: { value: '   ' } })
    clickOutside()
    expect((await screen.findByRole('alert')).textContent).toMatch(/título/)
    expect(onSave).not.toHaveBeenCalled()
    expect(readDraft(draftKey(CWD, SLUG, 'x'))?.fields.titulo).toBe('   ')
    // Corrigir tira o aviso sem precisar sair de novo.
    fireEvent.change(titulo(), { target: { value: 'Agora sim' } })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('sugestão sem fonte válida não grava; URL ou arquivo do projeto grava', async () => {
    const { onSave } = renderEditor(makeCard('x'))
    fireEvent.click(screen.getByRole('radio', { name: /Sugestão/ }))
    clickOutside()
    expect((await screen.findByRole('alert')).textContent).toMatch(/fonte/)
    fireEvent.change(screen.getByLabelText('Fonte'), { target: { value: '../fora.ts' } })
    clickOutside()
    await act(async () => {})
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Fonte'), { target: { value: 'src/a.ts:12' } })
    clickOutside()
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'sugestao', fonte: 'src/a.ts:12' }), 1))
  })

  it('Fechar com card inválido explica e não fecha; o 2º clique fecha e o rascunho fica', async () => {
    const { onSave, onClose } = renderEditor(makeCard('x'))
    fireEvent.change(titulo(), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/título/)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Fechar mesmo assim' }))
    expect(onClose).toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
    expect(readDraft(draftKey(CWD, SLUG, 'x'))).not.toBeNull()
  })
})

describe('CardEditor — rascunho em cache', () => {
  it('guarda o rascunho enquanto digita e o reaplica ao reabrir o mesmo card (com aviso)', async () => {
    const card = makeCard('login', { rev: 4, titulo: 'Login' })
    const never = vi.fn(() => new Promise<SaveCardOutcome>(() => {}))
    const first = renderEditor(card, { onSave: never })
    fireEvent.change(titulo(), { target: { value: 'Login novo' } })
    await waitFor(() => expect(readDraft(draftKey(CWD, SLUG, 'login'))?.fields.titulo).toBe('Login novo'))
    first.unmount() // o app fechou sem o arquivo ser gravado
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })

    const again = renderEditor(card)
    expect(titulo().value).toBe('Login novo')
    expect(screen.getByRole('status').textContent).toMatch(/rascunho/)
    // Reaplicado conta como mudança: fechar grava, e o rascunho gravado some.
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))
    await waitFor(() => expect(again.onClose).toHaveBeenCalled())
    expect(again.onSave).toHaveBeenCalledWith(expect.objectContaining({ titulo: 'Login novo' }), 4)
    expect(readDraft(draftKey(CWD, SLUG, 'login'))).toBeNull()
  })

  it('rascunho de um rev antigo é mesclado com o card atual ao abrir', () => {
    const old = makeCard('login', { rev: 4, titulo: 'Login', corpo: 'antes' })
    writeDraft(draftKey(CWD, SLUG, 'login'), {
      v: 1,
      fields: { ...fieldsOf(old), titulo: 'Título meu' },
      base: fieldsOf(old),
      baseRev: 4,
      savedAt: 1
    })
    renderEditor(makeCard('login', { rev: 6, titulo: 'Login', corpo: 'corpo do Manager' }))
    expect(titulo().value).toBe('Título meu')
    expect(corpo().value).toBe('corpo do Manager')
  })

  it('no StrictMode (o app usa), o monta-desmonta-monta do dev não grava o rascunho reaplicado', async () => {
    const card = makeCard('x', { titulo: 'Do disco' })
    writeDraft(draftKey(CWD, SLUG, 'x'), { v: 1, fields: { ...fieldsOf(card), titulo: 'Rascunho' }, base: fieldsOf(card), baseRev: 1, savedAt: 1 })
    const p = props(card)
    render(
      <StrictMode>
        <CardEditor {...p} />
      </StrictMode>
    )
    expect(titulo().value).toBe('Rascunho')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(p.onSave).not.toHaveBeenCalled()
    expect(readDraft(draftKey(CWD, SLUG, 'x'))?.fields.titulo).toBe('Rascunho')
  })

  it('Descartar volta ao card do disco e apaga o rascunho', () => {
    const card = makeCard('x', { titulo: 'Do disco' })
    writeDraft(draftKey(CWD, SLUG, 'x'), { v: 1, fields: { ...fieldsOf(card), titulo: 'Do rascunho' }, base: fieldsOf(card), baseRev: 1, savedAt: 1 })
    renderEditor(card)
    expect(titulo().value).toBe('Do rascunho')
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }))
    expect(titulo().value).toBe('Do disco')
    expect(readDraft(draftKey(CWD, SLUG, 'x'))).toBeNull()
  })
})

describe('CardEditor — conflito de rev', () => {
  it('merge por campo: o título do usuário + o corpo do Manager, gravado sobre o rev atual, com um aviso só', async () => {
    const mock = mockPlanningApi()
    const current = makeCard('login', { etapa: 'requisitos', titulo: 'Login com SSO', corpo: 'Corpo do Manager', rev: 6 })
    mock.api.planningSaveCard.mockResolvedValueOnce({ ok: false, code: 'rev_conflict', current } as never)
    render(
      <UiProvider>
        <Wired id="login" />
      </UiProvider>
    )
    await screen.findByLabelText('Título')
    fireEvent.change(titulo(), { target: { value: 'Login com SSO e MFA' } })
    clickOutside()
    await waitFor(() => expect(mock.api.planningSaveCard).toHaveBeenCalledTimes(2))
    expect(mock.api.planningSaveCard.mock.calls[1][0]).toMatchObject({
      expectedRev: 6,
      card: { id: 'login', titulo: 'Login com SSO e MFA', corpo: 'Corpo do Manager' }
    })
    const toast = await screen.findByText(MERGE_MSG)
    expect(toast.closest('.toast')?.classList.contains('aviso')).toBe(true)
    expect(screen.queryByText(/O card mudou enquanto você editava/)).toBeNull()
    await waitFor(() => expect(corpo().value).toBe('Corpo do Manager'))
    expect(titulo().value).toBe('Login com SSO e MFA')
  })

  it('card apagado pelo Manager: aviso, nada gravado, e o rascunho fica no cache', async () => {
    const notify = vi.fn()
    const onSave = vi.fn(async (): Promise<SaveCardOutcome> => ({ ok: false, conflict: true, current: null }))
    renderEditor(makeCard('x', { rev: 3 }), { onSave, notify })
    fireEvent.change(corpo(), { target: { value: 'texto que não pode sumir' } })
    clickOutside()
    await waitFor(() => expect(notify).toHaveBeenCalledWith('aviso', GONE_MSG))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(readDraft(draftKey(CWD, SLUG, 'x'))?.fields.corpo).toBe('texto que não pode sumir')
  })

  it('sem edição pendente, a versão nova vinda de fora é adotada (e o rev dela vale)', async () => {
    const card = makeCard('x', { rev: 4, titulo: 'Antes' })
    const { rerender, p } = renderEditor(card)
    rerender(<CardEditor {...p} card={{ ...card, rev: 9, titulo: 'Do Manager' }} />)
    expect(titulo().value).toBe('Do Manager')
    fireEvent.change(corpo(), { target: { value: 'meu' } })
    clickOutside()
    await waitFor(() => expect(p.onSave).toHaveBeenCalledWith(expect.objectContaining({ titulo: 'Do Manager', corpo: 'meu' }), 9))
  })

  it('com edição pendente, o rev fica o da abertura (o conflito é resolvido no merge)', async () => {
    const card = makeCard('x', { rev: 4 })
    const { rerender, p } = renderEditor(card)
    fireEvent.change(titulo(), { target: { value: 'Meu' } })
    rerender(<CardEditor {...p} card={{ ...card, rev: 9, titulo: 'Do Manager' }} />)
    expect(titulo().value).toBe('Meu')
    clickOutside()
    await waitFor(() => expect(p.onSave).toHaveBeenCalledWith(expect.objectContaining({ titulo: 'Meu' }), 4))
  })
})

describe('CardEditor — [[referência]] a outro card', () => {
  const cards = [
    makeCard('x', { titulo: 'O próprio card', tipo: 'nota' }),
    makeCard('banco', { titulo: 'Usar Postgres', tipo: 'decisao' }),
    makeCard('acao', { titulo: 'Ação de cobrança', tipo: 'nota' })
  ]

  it('"[[" abre a lista (sem o próprio card), filtra sem acento e Enter insere pelo NOME', () => {
    renderEditor(cards[0], { cards })
    // (as <option> do select de Etapa também são 'option': por isso o within)
    const options = (): HTMLElement[] => within(screen.getByRole('listbox')).getAllByRole('option')
    fireEvent.change(corpo(), { target: { value: 'Ver [[' } })
    const names = options().map((o) => o.textContent)
    expect(names).toHaveLength(2)
    expect(names.some((n) => n?.includes('O próprio card'))).toBe(false)
    fireEvent.change(corpo(), { target: { value: 'Ver [[acao' } })
    expect(options()).toHaveLength(1)
    expect(options()[0].getAttribute('data-tipo')).toBe('nota')
    fireEvent.keyDown(corpo(), { key: 'Enter' })
    expect(corpo().value).toBe('Ver [[Ação de cobrança]]')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('a prévia destaca [[Título]] com o tipo do card citado; o que não resolve fica sem destaque', () => {
    renderEditor(makeCard('x', { corpo: 'Ver [[usar postgres]] e [[Fantasma]]' }), { cards })
    fireEvent.click(screen.getByRole('tab', { name: 'Prévia' }))
    const ref = screen.getByText('usar postgres').closest('a')!
    expect(ref.getAttribute('href')).toBe('#card-ref/decisao/banco')
    expect(fireEvent.click(ref)).toBe(false) // não navega
    expect(screen.getByText(/\[\[Fantasma\]\]/).closest('a')).toBeNull()
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
