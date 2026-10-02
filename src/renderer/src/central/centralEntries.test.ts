import { describe, expect, it } from 'vitest'
import type { CentralEntry, CentralReplyEntry, CentralRequestEntry, CentralState } from '@shared/central'
import { MAX_CENTRAL_ENTRIES } from '@shared/central'
import {
  ADOPTED_TEXT_MAX_CHARS,
  ADOPTED_WHY,
  ANSWER_MAX_CHARS,
  MAX_REPLY_NOTES,
  NOTE_MAX_CHARS,
  adoptedRequestEntry,
  appendAdopted,
  capAnswer,
  capNotes,
  hasActiveAnchor,
  isOwnEntry,
  isRoutedEntry,
  markInjected,
  patchRequest,
  removeReplyOf,
  replyIdFor,
  replyOf,
  upsertReply
} from './centralEntries'

/**
 * As entradas da Central (puro): a adotada da Emenda A1, os tetos do que é gravado
 * (a Central é UMA linha regravada a cada mudança), o append idempotente pela
 * âncora e o upsert da resposta pelo id determinístico `reply:<requestId>`.
 */

const target = { kind: 'conversation' as const, convId: 'c1', cwd: 'C:\\proj\\alpha', project: 'alpha', title: 'Filtros', sandbox: false }

const request = (id: string, extra: Partial<CentralRequestEntry> = {}): CentralRequestEntry => ({
  kind: 'request',
  id,
  ts: 10,
  text: id,
  state: 'delivered',
  ...extra
})

const reply = (requestId: string, extra: Partial<CentralReplyEntry> = {}): CentralReplyEntry => ({
  kind: 'reply',
  id: replyIdFor(requestId),
  ts: 20,
  requestId,
  anchor: { convId: 'c1', msgId: 'u1' },
  notes: [],
  activity: { segments: [], text: '', count: 0, errors: 0 },
  done: false,
  ...extra
})

const state = (...entries: CentralEntry[]): CentralState => ({ entries })

describe('adoptedRequestEntry (A1)', () => {
  it('turno enviado na própria conversa: entregue, origem conversation, device, aviso e âncora', () => {
    const e = adoptedRequestEntry({ convId: 'c1', msgId: 'u1', text: 'o botão ficou torto', attachments: ['tela.png'], target, device: 'pc-1', now: 99 })
    expect(e).toMatchObject({
      kind: 'request',
      ts: 99,
      text: 'o botão ficou torto',
      attachments: ['tela.png'],
      state: 'delivered',
      origin: 'conversation',
      device: 'pc-1',
      route: { target, why: ADOPTED_WHY },
      anchor: { convId: 'c1', msgId: 'u1' }
    })
    expect(e.id).toMatch(/^req-/)
    expect(e).not.toHaveProperty('injected')
    expect(ADOPTED_WHY).toBe('enviada na própria conversa')
  })

  it('injetada leva injected: true; sem anexos e sem device, os campos não aparecem', () => {
    const e = adoptedRequestEntry({ convId: 'c1', msgId: 'u2', text: 'agora', attachments: [], target, injected: true })
    expect(e.injected).toBe(true)
    expect(e).not.toHaveProperty('attachments')
    expect(e).not.toHaveProperty('device')
  })

  it('texto adotado longo é cortado (o inteiro está na conversa)', () => {
    const e = adoptedRequestEntry({ convId: 'c1', msgId: 'u3', text: 'x'.repeat(ADOPTED_TEXT_MAX_CHARS + 50), attachments: [], target })
    expect(e.text).toHaveLength(ADOPTED_TEXT_MAX_CHARS)
    expect(e.text.endsWith('…')).toBe(true)
  })

  it('o alvo é copiado (mexer no original não muda a entrada)', () => {
    const t = { ...target }
    const e = adoptedRequestEntry({ convId: 'c1', msgId: 'u4', text: 'oi', attachments: [], target: t })
    t.title = 'outro'
    expect(e.route?.target).toMatchObject({ title: 'Filtros' })
  })
})

describe('appendAdopted', () => {
  it('acrescenta no fim e respeita o teto de entradas', () => {
    const full = state(...Array.from({ length: MAX_CENTRAL_ENTRIES }, (_, i) => request(`r${i}`)))
    const e = adoptedRequestEntry({ convId: 'c1', msgId: 'u9', text: 'nova', attachments: [], target })
    const next = appendAdopted(full, e)
    expect(next.entries).toHaveLength(MAX_CENTRAL_ENTRIES)
    expect(next.entries.at(-1)).toBe(e)
    expect(next.entries[0].id).toBe('r1')
  })

  it('a mesma âncora nunca entra duas vezes (devolve o MESMO estado)', () => {
    const s = state(request('r1', { anchor: { convId: 'c1', msgId: 'u1' } }))
    const e = adoptedRequestEntry({ convId: 'c1', msgId: 'u1', text: 'dup', attachments: [], target })
    expect(appendAdopted(s, e)).toBe(s)
  })

  it('estado ausente vira lista nova', () => {
    const e = adoptedRequestEntry({ convId: 'c1', msgId: 'u1', text: 'oi', attachments: [], target })
    expect(appendAdopted(undefined, e).entries).toEqual([e])
  })
})

describe('markInjected', () => {
  it('marca injected no pedido daquela âncora; sem o pedido, o mesmo estado', () => {
    const s = state(request('r1', { anchor: { convId: 'c1', msgId: 'u1' } }))
    expect(markInjected(s, 'c1', 'u1').entries[0]).toMatchObject({ id: 'r1', injected: true })
    expect(markInjected(s, 'c1', 'nada')).toBe(s)
  })
})

describe('tetos do que é gravado', () => {
  it('nota ≤ 600 e só as 12 últimas', () => {
    const notes = Array.from({ length: 15 }, (_, i) => (i === 14 ? 'y'.repeat(NOTE_MAX_CHARS + 10) : `n${i}`))
    const capped = capNotes(notes)
    expect(capped).toHaveLength(MAX_REPLY_NOTES)
    expect(capped[0]).toBe('n3')
    expect(capped.at(-1)).toHaveLength(NOTE_MAX_CHARS)
    expect(capped.at(-1)?.endsWith('…')).toBe(true)
  })

  it('resposta ≤ 4000 com "…"; curta e ausente passam', () => {
    expect(capAnswer('a'.repeat(ANSWER_MAX_CHARS + 1))).toHaveLength(ANSWER_MAX_CHARS)
    expect(capAnswer('pronto')).toBe('pronto')
    expect(capAnswer(undefined)).toBeUndefined()
    expect([NOTE_MAX_CHARS, MAX_REPLY_NOTES, ANSWER_MAX_CHARS]).toEqual([600, 12, 4000])
  })
})

describe('resposta: id determinístico, upsert e remoção', () => {
  it('replyIdFor = reply:<requestId>', () => {
    expect(replyIdFor('req-1')).toBe('reply:req-1')
  })

  it('upsert troca no lugar pelo id e acrescenta no fim quando é nova', () => {
    const s = state(request('r1'), reply('r1'), request('r2'))
    const updated = upsertReply(s, reply('r1', { notes: ['olhando'] }))
    expect(updated.entries.map((e) => e.id)).toEqual(['r1', 'reply:r1', 'r2'])
    expect(replyOf(updated.entries, 'r1')?.notes).toEqual(['olhando'])
    const added = upsertReply(s, reply('r2'))
    expect(added.entries.map((e) => e.id)).toEqual(['r1', 'reply:r1', 'r2', 'reply:r2'])
  })

  it('removeReplyOf tira a resposta do pedido (e só ela)', () => {
    const s = state(request('r1'), reply('r1'), request('r2'), reply('r2'))
    expect(removeReplyOf(s, 'r1').entries.map((e) => e.id)).toEqual(['r1', 'r2', 'reply:r2'])
    expect(removeReplyOf(state(request('r1')), 'r1').entries.map((e) => e.id)).toEqual(['r1'])
  })

  it('patchRequest muda só o pedido pedido', () => {
    const s = state(request('r1'), request('r2'))
    const next = patchRequest(s, 'r2', (e) => ({ ...e, state: 'asking' }))
    expect(next.entries[1]).toMatchObject({ id: 'r2', state: 'asking' })
    expect(next.entries[0]).toBe(s.entries[0])
  })
})

describe('donos e âncoras ativas', () => {
  it('isOwnEntry: sem device é deste PC; com device, só o próprio', () => {
    expect(isOwnEntry(request('r1'), 'pc-1')).toBe(true)
    expect(isOwnEntry(request('r1', { device: 'pc-1' }), 'pc-1')).toBe(true)
    expect(isOwnEntry(request('r1', { device: 'pc-2' }), 'pc-1')).toBe(false)
    expect(isOwnEntry(request('r1', { device: 'pc-2' }), undefined)).toBe(false)
  })

  it('isRoutedEntry: origem ausente ou central (as adotadas não têm "não era aqui")', () => {
    expect(isRoutedEntry(request('r1'))).toBe(true)
    expect(isRoutedEntry(request('r1', { origin: 'central' }))).toBe(true)
    expect(isRoutedEntry(request('r1', { origin: 'conversation' }))).toBe(false)
  })

  it('hasActiveAnchor: pedido ancorado na conversa sem resposta ou com resposta não terminada', () => {
    const anchored = request('r1', { anchor: { convId: 'c1', msgId: 'u1' } })
    expect(hasActiveAnchor([anchored], 'c1')).toBe(true)
    expect(hasActiveAnchor([anchored, reply('r1')], 'c1')).toBe(true)
    expect(hasActiveAnchor([anchored, reply('r1', { done: true })], 'c1')).toBe(false)
    expect(hasActiveAnchor([anchored], 'c2')).toBe(false)
    // Injetada não tem resposta própria: não conta como turno em aberto.
    expect(hasActiveAnchor([request('r2', { anchor: { convId: 'c3', msgId: 'u2' }, injected: true })], 'c3')).toBe(false)
  })
})
