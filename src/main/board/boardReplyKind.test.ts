// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { boardItemFromRow, boardSelectColumns, type BoardItemRow } from './boardModel'
import { boardReplyKindValue, nextBoardReplyKind } from './boardUserAction'

/** `po_reply_kind`: a regra única que SQLite e PostgreSQL aplicam, e a leitura. */

function row(over: Partial<BoardItemRow> = {}): BoardItemRow {
  return {
    id: 'bi-1',
    project_id: 'p',
    project_cwd: 'C:/p',
    conversation_id: 'conv-1',
    origin: 'po',
    source_id: null,
    source_title: 'Commitar a fase 1',
    source_status: 'pending',
    active_form: null,
    seq: 0,
    po_title: null,
    po_note: null,
    po_status: null,
    po_reason: null,
    po_at: null,
    dismissed_at: null,
    revision: 1,
    created_at: 'c',
    updated_at: 'u',
    ...over
  }
}

describe('boardReplyKindValue', () => {
  it('só authorize e answer valem; o resto é null', () => {
    expect(boardReplyKindValue('authorize')).toBe('authorize')
    expect(boardReplyKindValue('answer')).toBe('answer')
    for (const bad of ['AUTHORIZE', 'botao', '', null, undefined, 1, {}]) expect(boardReplyKindValue(bad)).toBeNull()
  })
})

describe('nextBoardReplyKind', () => {
  it('sem ação depois da escrita, nenhum controle', () => {
    expect(nextBoardReplyKind({ replyKind: 'authorize' }, 'answer', null)).toBeNull()
    expect(nextBoardReplyKind({}, 'answer', null)).toBeNull()
  })

  it('o pedido explícito vale (null e valor inválido limpam)', () => {
    expect(nextBoardReplyKind({ replyKind: 'answer' }, 'authorize', 'Escolher')).toBe('answer')
    expect(nextBoardReplyKind({ replyKind: null }, 'authorize', 'Escolher')).toBeNull()
    expect(nextBoardReplyKind({ replyKind: 'x' as never }, 'authorize', 'Escolher')).toBeNull()
  })

  it('ação nova ou troca de status sem controle limpam; senão fica o atual', () => {
    expect(nextBoardReplyKind({ userAction: 'Outra ação' }, 'authorize', 'Outra ação')).toBeNull()
    expect(nextBoardReplyKind({ poStatus: 'pending' }, 'authorize', 'Autorizar')).toBeNull()
    expect(nextBoardReplyKind({}, 'authorize', 'Autorizar')).toBe('authorize')
    expect(nextBoardReplyKind({}, 'lixo', 'Autorizar')).toBeNull()
  })
})

describe('leitura — boardItemFromRow e boardSelectColumns', () => {
  it('expõe poReplyKind só com ação e valor válido', () => {
    expect(boardItemFromRow(row({ po_user_action: 'Autorizar o commit', po_reply_kind: 'authorize' }))).toMatchObject({
      poUserAction: 'Autorizar o commit',
      poReplyKind: 'authorize'
    })
    expect(boardItemFromRow(row({ po_reply_kind: 'answer' }))).not.toHaveProperty('poReplyKind')
    expect(boardItemFromRow(row({ po_user_action: 'Escolher', po_reply_kind: 'outro' }))).not.toHaveProperty('poReplyKind')
    expect(boardItemFromRow(row())).not.toHaveProperty('poReplyKind')
  })

  it('a coluna só entra na leitura quando o banco a tem', () => {
    expect(boardSelectColumns()).toContain('po_reply_kind')
    expect(boardSelectColumns(true, true, false)).not.toContain('po_reply_kind')
  })
})
