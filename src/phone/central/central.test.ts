import { beforeEach, describe, expect, it } from 'vitest'
import type { RemoteCentralEntry } from '@shared/central'
import type { ChatMsg } from '../core/types'
import { centralQuoteOf, centralSnapshot, pruneCentral, tint, turnToolsOf } from './centralActions'
import { centralUi, takeCentralReply, setCentralReply } from './centralStore'

const delivered: RemoteCentralEntry = {
  kind: 'request', id: 'r1', ts: 1, text: 'Cria o cardápio', state: 'delivered',
  notice: { to: 'loja · Cardápio', why: 'site', color: '#6f9bd1' }, anchor: { convId: 'c1', msgId: 'u1' }
}

describe('Central no celular', () => {
  beforeEach(() => centralUi.set({ sent: [], busy: {}, picks: {}, why: {}, open: {}, tools: {}, replyTo: null }))

  it('retrato vazio enquanto o PC não publica', () => {
    expect(centralSnapshot([])).toEqual({ entries: [], rail: [], questions: [] })
  })

  it('só responde a pedido entregue, com destino e deste PC', () => {
    expect(centralQuoteOf(delivered)).toEqual({ id: 'r1', who: 'loja · Cardápio', color: '#6f9bd1', text: 'Cria o cardápio' })
    expect(centralQuoteOf({ ...delivered, state: 'asking' } as RemoteCentralEntry)).toBeNull()
    expect(centralQuoteOf({ ...delivered, foreign: true } as RemoteCentralEntry)).toBeNull()
    expect(centralQuoteOf({ ...delivered, anchor: undefined } as RemoteCentralEntry)).toBeNull()
  })

  it('cor do destino só da paleta (#hex); o resto vira a neutra', () => {
    expect(tint('#abc123')).toBe('#abc123')
    expect(tint('red; background:url(x)')).toBe('var(--muted)')
  })

  it('a bolha "enviando…" some quando o retrato traz o pedido; ids que já existiam não contam', () => {
    centralUi.set({ sent: [{ text: 'Cria o cardápio', files: 0, at: Date.now(), known: { r1: true } }] })
    pruneCentral({ entries: [delivered], rail: [], questions: [] })
    expect(centralUi.get().sent).toHaveLength(1) // r1 já existia antes do envio
    pruneCentral({ entries: [{ ...delivered, id: 'r2' }], rail: [], questions: [] })
    expect(centralUi.get().sent).toHaveLength(0)
  })

  it('escolha em andamento destrava quando o pedido deixa de perguntar', () => {
    centralUi.set({ busy: { r1: Date.now() } })
    pruneCentral({ entries: [{ ...delivered, state: 'asking' } as RemoteCentralEntry], rail: [], questions: [] })
    expect(centralUi.get().busy.r1).toBeDefined()
    pruneCentral({ entries: [delivered], rail: [], questions: [] })
    expect(centralUi.get().busy.r1).toBeUndefined()
  })

  it('modo resposta: o replyTo sai uma vez e o modo fecha', () => {
    setCentralReply({ id: 'r1', who: 'x', text: 't' })
    expect(takeCentralReply()).toBe('r1')
    expect(takeCentralReply()).toBeNull()
  })

  it('ações do turno: da âncora até a próxima mensagem que abre turno (ajuste injetado não fecha)', () => {
    const msgs = [
      { kind: 'user', id: 'u1', text: 'a' },
      { kind: 'tool-use', id: 't1', name: 'Read', input: {}, parentToolUseId: null },
      { kind: 'tool-use', id: 't2', name: 'TodoWrite', input: {}, parentToolUseId: null },
      { kind: 'user', id: 'u2', text: 'ajuste', injected: true },
      { kind: 'tool-use', id: 't3', name: 'Edit', input: {}, parentToolUseId: 'sub' },
      { kind: 'tool-use', id: 't4', name: 'Edit', input: {}, parentToolUseId: null },
      { kind: 'user', id: 'u3', text: 'outro turno' }
    ] as ChatMsg[]
    const turn = turnToolsOf(msgs, 'u1')
    expect(turn?.closed).toBe(true)
    expect(turn?.tools.map((m) => m.id)).toEqual(['t1', 't4'])
    expect(turnToolsOf(msgs, 'nao-existe')).toBeNull()
  })
})
