// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { BOARD_TURN_END_REASON, type BoardItem } from '../../shared/ipc'
import type { BoardPoCreate, BoardPoWrite } from '../persistence/types'
import { applyPoVerdict, poCreateReplyKind, type PoApplyDeps, type PoApplyTarget } from './poApply'
import { PO_ROUTINE_REASON } from './poAuthorization'
import { PO_AWAITING_AUTHORIZATION_REASON, PO_SYSTEM_PROMPT_CLOSE } from './poPrompt'
import { parsePoVerdict, poReplyKindSuffix, splitUserAction, type PoOp } from './poVerdict'

/**
 * O controle do cartão que o PO decide: o sufixo `| BOTÃO` (autorizar, botão
 * "Pode fazer") ou `| RESPONDER` (o usuário escreve) no fim do VOCÊ — lido pelo
 * parser, gravado junto da ação e com o padrão 'authorize' na NOVA que espera
 * autorização sem dizer o controle.
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

describe('parser — o sufixo do VOCÊ', () => {
  it('BOTÃO/BOTAO vira authorize e RESPONDER vira answer, sem acento e sem caixa', () => {
    for (const suffix of ['BOTÃO', 'BOTAO', 'botão', 'Botao']) {
      expect(splitUserAction(`PENDENTE bi-1 | motivo | VOCÊ: Autorizar o deploy | ${suffix}`)).toEqual({
        body: 'PENDENTE bi-1 | motivo',
        userAction: 'Autorizar o deploy',
        replyKind: 'authorize'
      })
    }
    for (const suffix of ['RESPONDER', 'responder', ' Responder ']) {
      expect(splitUserAction(`PENDENTE bi-1 | motivo | VOCÊ: Escolher A ou B |${suffix}`)).toMatchObject({
        userAction: 'Escolher A ou B',
        replyKind: 'answer'
      })
    }
  })

  it('PENDENTE e NOVA levam o kind; sem sufixo, nada muda (linha antiga)', () => {
    const raw = [
      'PENDENTE bi-1 | esperando o layout | VOCÊ: Escolher entre o layout A e o B | RESPONDER',
      `NOVA bi-1 | Atualizar a VPS | ${PO_AWAITING_AUTHORIZATION_REASON} | VOCÊ: Autorizar a atualização da VPS | BOTÃO`,
      'PENDENTE bi-2 | falta testar | VOCÊ: Testar o login no celular'
    ].join('\n')
    expect(parsePoVerdict(raw, ids, 'close')).toEqual([
      {
        kind: 'justify',
        id: 'bi-1',
        reason: 'esperando o layout',
        userAction: 'Escolher entre o layout A e o B',
        replyKind: 'answer'
      },
      {
        kind: 'create',
        title: 'Atualizar a VPS',
        reason: PO_AWAITING_AUTHORIZATION_REASON,
        status: 'pending',
        parentId: 'bi-1',
        userAction: 'Autorizar a atualização da VPS',
        replyKind: 'authorize'
      },
      { kind: 'justify', id: 'bi-2', reason: 'falta testar', userAction: 'Testar o login no celular' }
    ])
  })

  it('fim desconhecido depois do pipe (inclusive uma palavra em MAIÚSCULAS) fica na ação, sem kind', () => {
    expect(poReplyKindSuffix('Autorizar o deploy | SIM')).toEqual({ action: 'Autorizar o deploy | SIM', replyKind: null })
    expect(parsePoVerdict('PENDENTE bi-1 | motivo | VOCÊ: Escolher entre o layout A | B', ids)).toEqual([
      { kind: 'justify', id: 'bi-1', reason: 'motivo', userAction: 'Escolher entre o layout A | B' }
    ])
    expect(parsePoVerdict('PENDENTE bi-1 | motivo | VOCÊ: Liberar o acesso | VPS', ids)).toEqual([
      { kind: 'justify', id: 'bi-1', reason: 'motivo', userAction: 'Liberar o acesso | VPS' }
    ])
    expect(parsePoVerdict('PENDENTE bi-1 | motivo | VOCÊ: Escolher A | ou B', ids)).toEqual([
      { kind: 'justify', id: 'bi-1', reason: 'motivo', userAction: 'Escolher A | ou B' }
    ])
  })

  it('o corte de 120 vem DEPOIS de separar o sufixo; sufixo sem VOCÊ não vira kind', () => {
    const [op] = parsePoVerdict(`PENDENTE bi-1 | falta escolher | VOCÊ: ${'Escolher '.repeat(40)} | RESPONDER`, ids)
    expect(op.kind === 'justify' && op.userAction).toHaveLength(120)
    expect(op.kind === 'justify' && op.replyKind).toBe('answer')
    expect(parsePoVerdict('PENDENTE bi-1 | falta escolher | RESPONDER', ids)).toEqual([
      { kind: 'justify', id: 'bi-1', reason: 'falta escolher | RESPONDER' }
    ])
    expect(parsePoVerdict('PENDENTE bi-1 | falta | VOCÊ: | BOTÃO', ids)).toEqual([{ kind: 'justify', id: 'bi-1', reason: 'falta' }])
  })

  it('a NOVA que não nasce "a fazer" não guarda nem a ação nem o kind', () => {
    expect(parsePoVerdict('FEITA | Corrigir o build | corrigido | VOCÊ: Testar | BOTÃO', ids)).toEqual([
      { kind: 'create', title: 'Corrigir o build', reason: 'corrigido', status: 'completed' }
    ])
  })
})

describe('poCreateReplyKind — o padrão da NOVA', () => {
  const create = (over: Partial<Extract<PoOp, { kind: 'create' }>> = {}): Extract<PoOp, { kind: 'create' }> => ({
    kind: 'create',
    title: 'Commitar a fase 1',
    reason: PO_AWAITING_AUTHORIZATION_REASON,
    status: 'pending',
    ...over
  })

  it('o sufixo vale; sem ele, a de autorização ganha authorize; ação fora do app e sem ação, nada', () => {
    expect(poCreateReplyKind(create({ userAction: 'Autorizar o commit', replyKind: 'answer' }))).toBe('answer')
    expect(poCreateReplyKind(create())).toBe('authorize')
    expect(poCreateReplyKind(create({ userAction: 'Autorizar o commit' }))).toBe('authorize')
    expect(poCreateReplyKind(create({ userAction: 'Aprovar o formato' }))).toBe('authorize')
    expect(poCreateReplyKind(create({ userAction: 'Testar o desconto numa nota de filial' }))).toBeNull()
    expect(poCreateReplyKind(create({ reason: 'o agente parou sem a senha', userAction: 'Informar a senha' }))).toBeNull()
    expect(poCreateReplyKind(create({ reason: 'outro motivo' }))).toBeNull()
    expect(poCreateReplyKind(create({ status: 'in_progress', replyKind: 'authorize' }))).toBeNull()
  })
})

describe('applyPoVerdict — grava o kind junto da ação', () => {
  it('PENDENTE com sufixo grava replyKind; sem sufixo, a escrita é a de antes', async () => {
    const cards = [card('bi-1', 'in_progress'), card('bi-2', 'in_progress')]
    const d = deps(cards)
    const verdict = ['PENDENTE bi-1 | esperando o layout | VOCÊ: Escolher o layout | RESPONDER', 'PENDENTE bi-2 | falta | VOCÊ: Testar no celular'].join(
      '\n'
    )
    await applyPoVerdict(d, target, verdict, cards, { applied: 0, touched: [] })
    expect(d.board.applyPo).toHaveBeenCalledWith({
      id: 'bi-1',
      poReason: `${BOARD_TURN_END_REASON.result} — esperando o layout`,
      userAction: 'Escolher o layout',
      replyKind: 'answer',
      eventNote: 'esperando o layout'
    })
    const second = d.board.applyPo.mock.calls.map(([input]) => input).find((input) => input.id === 'bi-2')
    expect(second).toMatchObject({ userAction: 'Testar no celular' })
    expect(second).not.toHaveProperty('replyKind')
  })

  it('NOVA: o sufixo, o padrão authorize e nada na NOVA comum', async () => {
    const parent = card('bi-1', 'completed', { sourceTitle: 'Implementar a fase 1' })
    const d = deps([parent])
    const verdict = [
      `NOVA bi-1 | Escolher o tema do relatório | ${PO_AWAITING_AUTHORIZATION_REASON} | VOCÊ: Escolher entre claro e escuro | RESPONDER`,
      `NOVA bi-1 | Verificar a fase 1 no app rodando | ${PO_AWAITING_AUTHORIZATION_REASON}`,
      `NOVA bi-1 | Testar o desconto numa nota de filial | ${PO_AWAITING_AUTHORIZATION_REASON} | VOCÊ: Testar o desconto com uma nota de filial`,
      'NOVA | Implementar a tela de edição depois | o agente disse que faz na próxima'
    ].join('\n')
    await applyPoVerdict(d, target, verdict, [parent], { applied: 0, touched: [] })
    const calls = d.board.createPoItem.mock.calls.map(([input]) => input)
    expect(calls.map((input) => input.replyKind)).toEqual(['answer', 'authorize', undefined, undefined])
    expect(calls[2]).not.toHaveProperty('replyKind')
    expect(calls[3]).not.toHaveProperty('replyKind')
  })

  it('a pendência que vira rotina não ganha controle', async () => {
    const parent = card('bi-1', 'completed', { sourceTitle: 'Implementar a fase 1' })
    const d = deps([parent])
    const auth = { push: false, scope: 'sempre' as const, at: 'x' }
    const verdict = `NOVA bi-1 | Commitar a fase 1 | ${PO_AWAITING_AUTHORIZATION_REASON} | VOCÊ: Autorizar o commit | BOTÃO`
    await applyPoVerdict(d, { ...target, authorization: auth }, verdict, [parent], { applied: 0, touched: [] })
    const [input] = d.board.createPoItem.mock.calls[0]
    expect(input).toMatchObject({ reason: PO_ROUTINE_REASON })
    expect(input).not.toHaveProperty('replyKind')
  })
})

describe('prompt — explica cada controle', () => {
  it('BOTÃO para autorização, RESPONDER para escolha/informação, sem sufixo fora do app', () => {
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('VOCÊ: Autorizar o deploy na VPS | BOTÃO')
    expect(PO_SYSTEM_PROMPT_CLOSE).toMatch(/"\| BOTÃO" quando a ação é AUTORIZAR/)
    expect(PO_SYSTEM_PROMPT_CLOSE).toMatch(/"\| RESPONDER" quando a ação é uma ESCOLHA ou uma INFORMAÇÃO/)
    expect(PO_SYSTEM_PROMPT_CLOSE).toMatch(/Sem sufixo quando a ação acontece FORA do app/)
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('VOCÊ: Testar o login no celular')
  })
})
