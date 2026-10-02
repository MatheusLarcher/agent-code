import { describe, expect, it } from 'vitest'
import {
  CENTRAL_TITLE,
  MAX_CENTRAL_ENTRIES,
  type CentralEntry,
  type CentralReplyEntry,
  type CentralQuestionEntry,
  type CentralRequestEntry
} from '@shared/central'
import {
  appendCentralEntry,
  centralAttachmentNames,
  centralConversationFields,
  newCentralRequest,
  normalizeCentralState
} from './centralRegistry'

const req = (id: string, ts = 1): CentralRequestEntry => ({ kind: 'request', id, ts, text: id, state: 'routing' })

const reply: CentralReplyEntry = {
  kind: 'reply',
  id: 'rp1',
  ts: 2,
  requestId: 'r1',
  anchor: { convId: 'c1', msgId: 'u1' },
  notes: ['achei o filtro'],
  answer: 'Pronto.',
  activity: { segments: [{ text: 'Leu 1 arquivo' }], text: 'Leu 1 arquivo', count: 1, errors: 0 },
  done: true
}

const question: CentralQuestionEntry = { kind: 'question', id: 'q1', ts: 3, convId: 'c1', question: 'Qual?', answer: 'Google' }

describe('centralConversationFields', () => {
  it('é a Central: título travado, modo central, sem entradas e sem modos de sessão', () => {
    expect(centralConversationFields()).toEqual({
      title: CENTRAL_TITLE,
      titleSource: 'user',
      mode: 'central',
      central: { entries: [] },
      economyMode: false,
      loopEnabled: false,
      fastMode: false
    })
  })

  it('cada chamada devolve uma lista de entradas nova (nada compartilhado)', () => {
    const a = centralConversationFields()
    const b = centralConversationFields()
    expect(a.central).not.toBe(b.central)
    expect(a.central?.entries).not.toBe(b.central?.entries)
  })
})

describe('appendCentralEntry', () => {
  it('sem estado ainda: nasce com a entrada', () => {
    expect(appendCentralEntry(undefined, req('r1'))).toEqual({ entries: [req('r1')] })
  })

  it('acrescenta no fim, sem mexer no estado de entrada', () => {
    const before = { entries: [req('r1')] }
    const after = appendCentralEntry(before, req('r2'))
    expect(after.entries.map((e) => e.id)).toEqual(['r1', 'r2'])
    expect(before.entries.map((e) => e.id)).toEqual(['r1'])
    expect(after).not.toBe(before)
  })

  it('passou do teto: as mais antigas saem primeiro', () => {
    const full = { entries: Array.from({ length: MAX_CENTRAL_ENTRIES }, (_, i) => req(`r${i}`)) }
    const after = appendCentralEntry(full, req('nova'))
    expect(after.entries).toHaveLength(MAX_CENTRAL_ENTRIES)
    expect(after.entries[0].id).toBe('r1')
    expect(after.entries.at(-1)?.id).toBe('nova')
  })

  it('estado vindo torto do banco não derruba: vira lista nova', () => {
    const torto = { entries: 'nada' } as unknown as { entries: CentralEntry[] }
    expect(appendCentralEntry(torto, req('r1')).entries.map((e) => e.id)).toEqual(['r1'])
  })
})

describe('newCentralRequest', () => {
  it('pedido em "routing", com o texto, os nomes dos anexos e a hora dada', () => {
    const e = newCentralRequest('deixa mais escuro', ['print.png'], 1234)
    expect(e).toMatchObject({ kind: 'request', ts: 1234, text: 'deixa mais escuro', attachments: ['print.png'], state: 'routing' })
    expect(typeof e.id).toBe('string')
    expect(e.id.length).toBeGreaterThan(0)
  })

  it('sem anexo: o campo nem aparece (payload leve)', () => {
    expect(newCentralRequest('oi', [], 1)).not.toHaveProperty('attachments')
  })

  it('ids únicos mesmo no mesmo milissegundo', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newCentralRequest('x', [], 5).id))
    expect(ids.size).toBe(200)
  })

  it('a lista de anexos é copiada (mexer na original não muda a entrada)', () => {
    const names = ['a.png']
    const e = newCentralRequest('x', names, 1)
    names.push('b.png')
    expect(e.attachments).toEqual(['a.png'])
  })
})

describe('normalizeCentralState (fronteira: payload do banco)', () => {
  it('valor que não é estado vira estado vazio', () => {
    for (const v of [undefined, null, 'x', 3, [], { entries: 'x' }]) {
      expect(normalizeCentralState(v)).toEqual({ entries: [] })
    }
  })

  it('mantém as entradas válidas dos três tipos, na ordem', () => {
    const state = { entries: [req('r1'), reply, question] }
    expect(normalizeCentralState(state)).toEqual(state)
  })

  it('descarta entradas tortas (tipo, id, hora, texto ou estado inválidos)', () => {
    const state = {
      entries: [
        req('ok'),
        null,
        'texto',
        { ...req('sem-kind'), kind: 'outro' },
        { ...req('id-vazio'), id: '' },
        { ...req('ts-ruim'), ts: Number.NaN },
        { ...req('sem-texto'), text: 7 },
        { ...req('estado-ruim'), state: 'perdido' },
        { ...req('anexo-ruim'), attachments: [1] },
        { ...reply, id: 'rp-sem-anchor', anchor: null },
        { ...reply, id: 'rp-sem-notes', notes: 'x' },
        { ...question, id: 'q-sem-pergunta', question: undefined }
      ]
    }
    expect(normalizeCentralState(state).entries.map((e) => e.id)).toEqual(['ok'])
  })

  it('corta no teto, ficando com as mais novas', () => {
    const many = { entries: Array.from({ length: MAX_CENTRAL_ENTRIES + 5 }, (_, i) => req(`r${i}`)) }
    const out = normalizeCentralState(many)
    expect(out.entries).toHaveLength(MAX_CENTRAL_ENTRIES)
    expect(out.entries[0].id).toBe('r5')
  })
})

describe('centralAttachmentNames', () => {
  it('nomes na ordem dos {{midia:N}} (imagem pelo rótulo; arquivo e referência pelo nome)', () => {
    const names = centralAttachmentNames(
      [{ mediaType: 'image/png', data: 'QUJD', label: 'midia:2 = tela.png' }],
      [{ name: 'planilha.xlsx', mediaType: 'x', data: '', size: 1, label: 'midia:3 = planilha.xlsx' }],
      [{ name: 'notas.pdf', path: 'C:\\n\\notas.pdf', mediaType: 'application/pdf', size: 1, label: 'midia:1 = notas.pdf' }]
    )
    expect(names).toEqual(['notas.pdf', 'tela.png', 'planilha.xlsx'])
  })

  it('sem rótulo (imagem do celular): "imagem", depois dos rotulados', () => {
    expect(
      centralAttachmentNames(
        [{ mediaType: 'image/jpeg', data: 'QUJD' }],
        [{ name: 'a.txt', mediaType: 'text/plain', data: '', size: 1, label: 'midia:1 = a.txt' }],
        []
      )
    ).toEqual(['a.txt', 'imagem'])
  })
})
