import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { PlanningCardDto } from '@shared/ipc'
import {
  cardProblem,
  composeCard,
  draftKey,
  fieldsOf,
  mergeFields,
  readDraft,
  restoreDraft,
  sameContent,
  sameFields,
  useCardAutosave,
  writeDraft,
  type CardAutosaveOptions
} from './cardDraft'
import type { SaveCardOutcome } from './usePlanning'
import { CWD, SLUG, makeCard } from './planningTestUtils'

beforeEach(() => localStorage.clear())
afterEach(async () => {
  cleanup()
  // A gravação do unmount sai num setTimeout: roda aqui, antes do próximo teste.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5))
  })
})

describe('mergeFields — merge por campo', () => {
  it('campo que o usuário mudou fica com o dele; o que só o outro mudou fica com o do outro', () => {
    const base = fieldsOf(makeCard('x', { titulo: 'A', corpo: 'c0', etapa: 'e1' }))
    const mine = { ...base, titulo: 'A do usuário' }
    const theirs = { ...base, corpo: 'c do Manager', etapa: 'e2' }
    expect(mergeFields(base, mine, theirs)).toEqual({ ...base, titulo: 'A do usuário', corpo: 'c do Manager', etapa: 'e2' })
  })

  it('os dois mudaram o mesmo campo: ganha o usuário', () => {
    const base = fieldsOf(makeCard('x', { corpo: 'c0' }))
    expect(mergeFields(base, { ...base, corpo: 'meu' }, { ...base, corpo: 'dele' }).corpo).toBe('meu')
  })
})

describe('anexos no rascunho', () => {
  it('fieldsOf/composeCard levam os anexos; sem anexos, a chave nem aparece', () => {
    const c = makeCard('x', { tipo: 'midia', anexos: ['a1b2c3-tela.png'] })
    const f = fieldsOf(c)
    expect(f.anexos).toEqual(['a1b2c3-tela.png'])
    expect(f.anexos).not.toBe(c.anexos) // cópia: editar não mexe no card aberto
    expect(composeCard(f, c).anexos).toEqual(['a1b2c3-tela.png'])
    expect('anexos' in composeCard({ ...f, anexos: [] }, c)).toBe(false)
  })

  it('sameFields/sameContent comparam os anexos pelo conteúdo e pela ordem', () => {
    const c = makeCard('x', { anexos: ['a1b2c3-a.png', 'a1b2c3-b.png'] })
    expect(sameFields(fieldsOf(c), fieldsOf({ ...c, anexos: [...c.anexos!] }))).toBe(true)
    expect(sameFields(fieldsOf(c), fieldsOf({ ...c, anexos: ['a1b2c3-b.png', 'a1b2c3-a.png'] }))).toBe(false)
    expect(sameContent(c, { ...c, anexos: ['a1b2c3-a.png'] })).toBe(false)
    expect(sameContent(makeCard('y'), { ...makeCard('y'), anexos: [] })).toBe(true)
  })

  it('mergeFields: anexo que o usuário tirou fica tirado; o que só o Manager pôs, entra', () => {
    const base = fieldsOf(makeCard('x', { anexos: ['a1b2c3-a.png'] }))
    expect(mergeFields(base, { ...base, anexos: [] }, { ...base, corpo: 'dele' })).toMatchObject({ anexos: [], corpo: 'dele' })
    expect(mergeFields(base, { ...base, titulo: 'meu' }, { ...base, anexos: ['a1b2c3-a.png', 'a1b2c3-b.png'] }).anexos).toEqual([
      'a1b2c3-a.png',
      'a1b2c3-b.png'
    ])
  })

  it('cardProblem: mídia sem anexo, anexo repetido, nome inválido e anexos demais', () => {
    const c = makeCard('x', { tipo: 'midia' })
    expect(cardProblem(c)).toMatch(/Card de mídia precisa de pelo menos um anexo/)
    expect(cardProblem({ ...c, anexos: ['a1b2c3-a.png'] })).toBeNull()
    expect(cardProblem({ ...c, anexos: ['a1b2c3-a.png', 'a1b2c3-a.png'] })).toMatch(/duas vezes/)
    expect(cardProblem({ ...c, anexos: ['../fora.png'] })).toMatch(/nome inválido/)
    expect(cardProblem({ ...c, anexos: Array.from({ length: 21 }, (_, i) => `a1b2c3-${i}.png`) })).toMatch(/Anexos demais/)
    // Anexo em card de outro tipo vale; sem anexo também.
    expect(cardProblem(makeCard('n', { tipo: 'nota', anexos: ['a1b2c3-a.pdf'] }))).toBeNull()
  })

  it('rascunho de antes dos anexos (sem a chave) ainda abre, como "sem anexos"', () => {
    const key = draftKey(CWD, SLUG, 'x')
    const old = { titulo: 'T', tipo: 'nota', etapa: '', fonte: '', status: '', corpo: 'rascunho' }
    localStorage.setItem(key, JSON.stringify({ v: 1, fields: old, base: { ...old, corpo: '' }, baseRev: 1, savedAt: 1 }))
    expect(readDraft(key)?.fields).toEqual({ ...old, anexos: [] })
    localStorage.setItem(key, JSON.stringify({ v: 1, fields: { ...old, anexos: [1] }, base: old, baseRev: 1, savedAt: 1 }))
    expect(readDraft(key)).toBeNull()
  })
})

describe('composeCard / cardProblem', () => {
  it('título sem espaço sobrando; links e rev vêm da versão de baixo; status só em ambiguidade', () => {
    const over = makeCard('x', { links: ['y'], rev: 7, tipo: 'ambiguidade', status: 'aberta' })
    const f = { ...fieldsOf(over), titulo: '  Novo  ', tipo: 'nota' as const }
    expect(composeCard(f, over)).toEqual({ id: 'x', tipo: 'nota', titulo: 'Novo', links: ['y'], rev: 7, corpo: '' })
    expect(composeCard({ ...f, tipo: 'ambiguidade', status: '' }, over).status).toBe('aberta')
  })

  it('motivos: título vazio, sugestão sem fonte, fonte fora da regra', () => {
    const c = makeCard('x')
    expect(cardProblem({ ...c, titulo: '' })).toMatch(/título/)
    expect(cardProblem({ ...c, tipo: 'sugestao' })).toMatch(/fonte/)
    expect(cardProblem({ ...c, tipo: 'sugestao', fonte: 'C:\\x.ts' })).toMatch(/Fonte inválida/)
    expect(cardProblem({ ...c, tipo: 'sugestao', fonte: 'src/a.ts:12' })).toBeNull()
    expect(cardProblem({ ...c, tipo: 'sugestao', fonte: 'https://x.org' })).toBeNull()
  })
})

describe('rascunho no localStorage', () => {
  it('a chave separa projeto (sem ligar para barra/caixa), plano e card; card novo tem chave própria', () => {
    expect(draftKey('C:\\Proj\\App\\', 'p', 'x')).toBe(draftKey('c:/proj/app', 'p', 'x'))
    expect(draftKey(CWD, 'p', 'x')).not.toBe(draftKey(CWD, 'q', 'x'))
    expect(draftKey(CWD, 'p', '')).not.toBe(draftKey(CWD, 'p', 'x'))
  })

  it('rascunho corrompido é ignorado', () => {
    localStorage.setItem(draftKey(CWD, SLUG, 'x'), '{quebrado')
    expect(readDraft(draftKey(CWD, SLUG, 'x'))).toBeNull()
    localStorage.setItem(draftKey(CWD, SLUG, 'x'), JSON.stringify({ v: 1, fields: { titulo: 1 } }))
    expect(readDraft(draftKey(CWD, SLUG, 'x'))).toBeNull()
  })

  it('rascunho igual ao card não conta como restaurado (e é limpo)', () => {
    const card = makeCard('x')
    const key = draftKey(CWD, SLUG, 'x')
    writeDraft(key, { v: 1, fields: fieldsOf(card), base: fieldsOf(card), baseRev: card.rev, savedAt: 1 })
    expect(restoreDraft(card, key)).toEqual({ fields: fieldsOf(card), restored: false })
    expect(readDraft(key)).toBeNull()
  })
})

describe('useCardAutosave', () => {
  function setup(card: PlanningCardDto, onSave: CardAutosaveOptions['onSave'], over: Partial<CardAutosaveOptions> = {}) {
    return renderHook((p: CardAutosaveOptions) => useCardAutosave(p), {
      initialProps: { card, isNew: false, existingIds: [], projectCwd: CWD, slug: SLUG, onSave, ...over }
    })
  }

  it('o que foi digitado DURANTE a gravação continua pendente (e no rascunho)', async () => {
    let release: (o: SaveCardOutcome) => void = () => {}
    const onSave = vi.fn(() => new Promise<SaveCardOutcome>((r) => (release = r)))
    const card = makeCard('x', { rev: 2, titulo: 'A' })
    const { result } = setup(card, onSave)
    act(() => result.current.setField('titulo', 'B'))
    let flushed: Promise<unknown> = Promise.resolve()
    act(() => {
      flushed = result.current.flush()
    })
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    act(() => result.current.setField('corpo', 'digitado enquanto gravava'))
    await act(async () => {
      release({ ok: true, card: { ...card, titulo: 'B', rev: 3 } })
      await flushed
    })
    expect(result.current.base.rev).toBe(3)
    expect(result.current.fields.titulo).toBe('B')
    expect(result.current.fields.corpo).toBe('digitado enquanto gravava')
    expect(result.current.dirty).toBe(true)
    expect(readDraft(draftKey(CWD, SLUG, 'x'))?.fields.corpo).toBe('digitado enquanto gravava')
  })

  it('duas saídas seguidas entram em fila: a 2ª não grava de novo com o rev velho', async () => {
    const onSave = vi.fn(async (c: PlanningCardDto, rev: number): Promise<SaveCardOutcome> => ({ ok: true, card: { ...c, rev: rev + 1 } }))
    const { result } = setup(makeCard('x', { rev: 1 }), onSave)
    act(() => result.current.setField('titulo', 'Novo'))
    await act(async () => {
      await Promise.all([result.current.flush(), result.current.flush()])
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(sameFields(result.current.fields, fieldsOf(result.current.base))).toBe(true)
  })

  it('hold suspende a gravação e forget descarta o rascunho de vez', async () => {
    const onSave = vi.fn()
    const { result } = setup(makeCard('x'), onSave)
    act(() => result.current.setField('titulo', 'Novo'))
    act(() => result.current.hold(true))
    await act(async () => {
      expect(await result.current.flush()).toBe('skipped')
    })
    act(() => result.current.forget())
    expect(readDraft(draftKey(CWD, SLUG, 'x'))).toBeNull()
    expect(onSave).not.toHaveBeenCalled()
  })
})
