// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { BOARD_TURN_END_REASON, type BoardItem } from '../../shared/ipc'
import type { BoardPoCreate, BoardPoWrite } from '../persistence/types'
import { applyPoVerdict, poCreateUserAction, type PoApplyDeps, type PoApplyTarget } from './poApply'
import { PO_ROUTINE_REASON } from './poAuthorization'
import { PO_AWAITING_AUTHORIZATION_REASON, PO_SYSTEM_PROMPT_CLOSE } from './poPrompt'
import { parsePoVerdict, type PoOp } from './poVerdict'

/**
 * O campo VOCÊ do PO — o que o USUÁRIO precisa fazer para o cartão "a fazer"
 * andar: lido do PENDENTE e da NOVA (opcional, cortado em 120), gravado no
 * justify e na NOVA, e com o padrão "Autorizar: <título>" na NOVA que espera
 * autorização sem dizer qual.
 */

function card(id: string, sourceStatus: BoardItem['sourceStatus'], over: Partial<BoardItem> = {}): BoardItem {
  return {
    id,
    projectId: 'p',
    projectCwd: 'C:/p',
    conversationId: 'conv-1',
    origin: 'agent',
    sourceId: id,
    sourceTitle: `tarefa ${id}`,
    sourceStatus,
    activeForm: null,
    seq: 0,
    poTitle: null,
    poNote: null,
    poStatus: null,
    poReason: null,
    poAt: null,
    dismissedAt: null,
    revision: 1,
    createdAt: '',
    updatedAt: '',
    ...over
  }
}

function deps(fresh: BoardItem[]) {
  const board = {
    list: vi.fn(async () => fresh),
    applyPo: vi.fn(async (_input: BoardPoWrite): Promise<BoardItem | null> => null),
    createPoItem: vi.fn(async (_input: BoardPoCreate): Promise<BoardItem | null> => null)
  }
  return { board, linkableLedgerTasks: async () => [], queueRoutine: vi.fn(async () => undefined) } as PoApplyDeps & {
    board: typeof board
  }
}

const target: PoApplyTarget = { convId: 'conv-1', cwd: 'C:/p', projectId: 'p', phase: 'close', startedAt: 0, returned: [] }
const ids = ['bi-1', 'bi-2']

describe('parser — o campo VOCÊ', () => {
  it('PENDENTE sem VOCÊ continua como antes: o cartão espera o agente', () => {
    expect(parsePoVerdict('PENDENTE bi-1 | falta implementar a tela de edição', ids)).toEqual([
      { kind: 'justify', id: 'bi-1', reason: 'falta implementar a tela de edição' }
    ])
  })

  it('PENDENTE com VOCÊ separa a ação do motivo (VOCÊ:/VOCE:, sem diferenciar caixa)', () => {
    const expected = { kind: 'justify', id: 'bi-1', reason: 'esperando a escolha do layout', userAction: 'Escolher entre o layout A e o B' }
    for (const marker of ['VOCÊ:', 'VOCE:', 'você:', 'Voce :']) {
      expect(parsePoVerdict(`PENDENTE bi-1 | esperando a escolha do layout | ${marker} Escolher entre o layout A e o B`, ids)).toEqual([
        expected
      ])
    }
  })

  it('NOVA com VOCÊ, com e sem o cartão de origem: o motivo não engole a ação', () => {
    const raw = [
      `NOVA bi-1 | Atualizar a VPS | ${PO_AWAITING_AUTHORIZATION_REASON} | VOCÊ: Autorizar a atualização da VPS`,
      'NOVA | Informar a senha de homologação | o agente parou sem a senha | VOCÊ: Informar a senha do banco'
    ].join('\n')
    expect(parsePoVerdict(raw, ids, 'close')).toEqual([
      {
        kind: 'create',
        title: 'Atualizar a VPS',
        reason: PO_AWAITING_AUTHORIZATION_REASON,
        status: 'pending',
        parentId: 'bi-1',
        userAction: 'Autorizar a atualização da VPS'
      },
      {
        kind: 'create',
        title: 'Informar a senha de homologação',
        reason: 'o agente parou sem a senha',
        status: 'pending',
        userAction: 'Informar a senha do banco'
      }
    ])
  })

  it('pipe extra no motivo fica no motivo; só o campo VOCÊ sai', () => {
    expect(parsePoVerdict('PENDENTE bi-1 | falta A | falta B | VOCÊ: Escolher entre A e B', ids)).toEqual([
      { kind: 'justify', id: 'bi-1', reason: 'falta A | falta B', userAction: 'Escolher entre A e B' }
    ])
    expect(parsePoVerdict('NOVA | Commitar a fase 1 | motivo | detalhe | VOCÊ: Autorizar o commit', ids)).toEqual([
      { kind: 'create', title: 'Commitar a fase 1', reason: 'motivo | detalhe', status: 'pending', userAction: 'Autorizar o commit' }
    ])
  })

  it('a ação é cortada em 120 caracteres', () => {
    const [op] = parsePoVerdict(`PENDENTE bi-1 | falta escolher | VOCÊ: ${'Escolher '.repeat(40)}`, ids)
    expect(op.kind === 'justify' && op.userAction).toHaveLength(120)
    expect(op.kind === 'justify' && op.userAction?.endsWith('…')).toBe(true)
  })

  it('"você" no meio do motivo não é o marcador, e VOCÊ vazio é ignorado', () => {
    expect(parsePoVerdict('PENDENTE bi-1 | esperando você escolher: A ou B', ids)).toEqual([
      { kind: 'justify', id: 'bi-1', reason: 'esperando você escolher: A ou B' }
    ])
    expect(parsePoVerdict('PENDENTE bi-1 | falta escolher | VOCÊ:   ', ids)).toEqual([
      { kind: 'justify', id: 'bi-1', reason: 'falta escolher' }
    ])
  })

  it('só o cartão que nasce "a fazer" guarda a ação; num CONCLUIR ela só sai do motivo', () => {
    expect(parsePoVerdict('NOVA | Implementar o login | pedido agora | VOCÊ: Testar', ids, 'open')).toEqual([
      { kind: 'create', title: 'Implementar o login', reason: 'pedido agora', status: 'in_progress' }
    ])
    expect(parsePoVerdict('FEITA | Corrigir o build | corrigido | VOCÊ: Testar', ids)).toEqual([
      { kind: 'create', title: 'Corrigir o build', reason: 'corrigido', status: 'completed' }
    ])
    expect(parsePoVerdict('CONCLUIR bi-1 | entregue | VOCÊ: Testar', ids)).toEqual([
      { kind: 'complete', id: 'bi-1', reason: 'entregue' }
    ])
  })

  it('o prompt de fechamento pede o VOCÊ quando o cartão espera o usuário e manda omitir quando espera o agente', () => {
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('PENDENTE <id> | <o que faltou> | VOCÊ: <ação do usuário>')
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('NOVA <id do cartão de origem> | <título> | <motivo curto> | VOCÊ: <ação do usuário>')
    expect(PO_SYSTEM_PROMPT_CLOSE).toMatch(/Escreva-o SEMPRE que o cartão fica esperando o\s+usuário/)
    expect(PO_SYSTEM_PROMPT_CLOSE).toMatch(/"Escolher entre A e B", "Autorizar o deploy na\s+VPS"/)
    expect(PO_SYSTEM_PROMPT_CLOSE).toMatch(/Omita o campo\s+inteiro quando o cartão espera o AGENTE/)
  })
})

describe('poCreateUserAction — o padrão da NOVA que espera autorização', () => {
  const create = (over: Partial<Extract<PoOp, { kind: 'create' }>> = {}): Extract<PoOp, { kind: 'create' }> => ({
    kind: 'create',
    title: 'Commitar a fase 1',
    reason: PO_AWAITING_AUTHORIZATION_REASON,
    status: 'pending',
    ...over
  })

  it('o VOCÊ vale; sem ele, "Autorizar: <título>" só na que espera autorização e nasce "a fazer"', () => {
    expect(poCreateUserAction(create({ userAction: 'Autorizar o commit' }))).toBe('Autorizar o commit')
    expect(poCreateUserAction(create())).toBe('Autorizar: Commitar a fase 1')
    expect(poCreateUserAction(create({ reason: 'o agente disse que faz depois' }))).toBeNull()
    expect(poCreateUserAction(create({ status: 'in_progress' }))).toBeNull()
    expect(poCreateUserAction(create({ title: 't'.repeat(200) }))).toHaveLength(120)
  })
})

describe('applyPoVerdict — grava a ação', () => {
  it('PENDENTE com VOCÊ grava a ação junto do motivo', async () => {
    const cards = [card('bi-1', 'in_progress')]
    const d = deps(cards)
    await applyPoVerdict(d, target, 'PENDENTE bi-1 | esperando o layout | VOCÊ: Escolher o layout', cards, { applied: 0, touched: [] })
    expect(d.board.applyPo).toHaveBeenCalledWith({
      id: 'bi-1',
      poReason: `${BOARD_TURN_END_REASON.result} — esperando o layout`,
      userAction: 'Escolher o layout',
      eventNote: 'esperando o layout'
    })
  })

  it('NOVA: o VOCÊ, o padrão "Autorizar: <título>", e nada quando o cartão não espera o usuário', async () => {
    const parent = card('bi-1', 'completed', { sourceTitle: 'Implementar a fase 1' })
    const d = deps([parent])
    const verdict = [
      `NOVA bi-1 | Atualizar a VPS de produção | ${PO_AWAITING_AUTHORIZATION_REASON} | VOCÊ: Autorizar a atualização da VPS`,
      `NOVA bi-1 | Verificar a fase 1 no app rodando | ${PO_AWAITING_AUTHORIZATION_REASON}`,
      'NOVA | Implementar a tela de edição depois | o agente disse que faz na próxima'
    ].join('\n')
    await applyPoVerdict(d, target, verdict, [parent], { applied: 0, touched: [] })
    const calls = d.board.createPoItem.mock.calls.map(([input]) => input)
    expect(calls.map((input) => input.userAction)).toEqual([
      'Autorizar a atualização da VPS',
      'Autorizar: Verificar a fase 1 no app rodando',
      undefined
    ])
    expect(calls[2]).not.toHaveProperty('userAction')
  })

  it('a pendência que vira rotina (commit autorizado) não espera ninguém: sem ação', async () => {
    const parent = card('bi-1', 'completed', { sourceTitle: 'Implementar a fase 1' })
    const d = deps([parent])
    const auth = { push: false, scope: 'sempre' as const, at: 'x' }
    const verdict = `NOVA bi-1 | Commitar a fase 1 | ${PO_AWAITING_AUTHORIZATION_REASON} | VOCÊ: Autorizar o commit`
    await applyPoVerdict(d, { ...target, authorization: auth }, verdict, [parent], { applied: 0, touched: [] })
    const [input] = d.board.createPoItem.mock.calls[0]
    expect(input).toMatchObject({ reason: PO_ROUTINE_REASON })
    expect(input).not.toHaveProperty('userAction')
  })
})
