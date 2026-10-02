import { describe, expect, it } from 'vitest'
import {
  CENTRAL_ID,
  MAX_CENTRAL_ENTRIES,
  type CentralEntry,
  type CentralReplyEntry,
  type CentralRequestEntry
} from '@shared/central'
import type { Conversation } from '../types'
import { mergeCentralConversation } from './centralMerge'

const A = 'pc-a'
const B = 'pc-b'

// `device` chega ao tipo compartilhado pela Tarefa 5: até lá, entra por cast.
function req(id: string, ts: number, device?: string, extra: Partial<CentralRequestEntry> = {}): CentralEntry {
  return { kind: 'request', id, ts, text: id, state: 'delivered', ...extra, ...(device ? { device } : {}) } as CentralEntry
}

function reply(id: string, ts: number, requestId: string, device?: string, extra: Partial<CentralReplyEntry> = {}): CentralEntry {
  return {
    kind: 'reply',
    id,
    ts,
    requestId,
    anchor: { convId: 'c1', msgId: 'u1' },
    notes: [],
    activity: { segments: [], text: '', count: 0, errors: 0 },
    done: false,
    ...extra,
    ...(device ? { device } : {})
  } as CentralEntry
}

function central(entries: CentralEntry[] | undefined, extra: Partial<Conversation> = {}): Conversation {
  return {
    id: CENTRAL_ID,
    title: 'Central',
    cwd: '',
    mode: 'central',
    model: 'claude-opus-5-5',
    sdkSessionId: null,
    messages: [],
    tokens: { context: 0, output: 0, cost: 0 },
    createdAt: 1,
    updatedAt: 10,
    ...(entries ? { central: { entries } } : {}),
    ...extra
  }
}

const ids = (conv: Conversation): string[] => (conv.central?.entries ?? []).map((e) => e.id)
const entry = (conv: Conversation, id: string): CentralEntry | undefined => conv.central?.entries.find((e) => e.id === id)

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner)
    Object.freeze(value)
  }
  return value
}

describe('mergeCentralConversation — dono de cada entrada', () => {
  it('próprias: vale exatamente a lista local (a que sumiu daqui foi apagada aqui e continua fora)', () => {
    const local = central([req('a1', 1, A, { text: 'nova' }), req('a3', 3, A)])
    const remote = central([req('a1', 1, A, { text: 'velha' }), req('a2', 2, A), req('b1', 4, B)])
    const out = mergeCentralConversation(local, remote, A)
    expect(ids(out)).toEqual(['a1', 'a3', 'b1'])
    expect(entry(out, 'a1')).toMatchObject({ text: 'nova' })
  })

  it('de outro PC: vale exatamente a lista remota (a versão dele, e o que ele apagou some daqui)', () => {
    const local = central([req('b1', 1, B, { text: 'velha' }), req('b2', 2, B), req('a1', 3, A)])
    const remote = central([req('b1', 1, B, { text: 'nova' }), req('b3', 4, B)])
    const out = mergeCentralConversation(local, remote, A)
    expect(ids(out)).toEqual(['b1', 'a1', 'b3'])
    expect(entry(out, 'b1')).toMatchObject({ text: 'nova' })
  })

  it('legado (sem dono): união por id, a versão local vence', () => {
    const local = central([req('l1', 1, undefined, { text: 'local' }), req('l2', 2)])
    const remote = central([req('l1', 1, undefined, { text: 'remota' }), req('l3', 3)])
    const out = mergeCentralConversation(local, remote, A)
    expect(ids(out)).toEqual(['l1', 'l2', 'l3'])
    expect(entry(out, 'l1')).toMatchObject({ text: 'local' })
  })

  it('resposta sem device herda o dono do pedido (achado em qualquer dos lados)', () => {
    const local = central([
      req('rA', 1, A),
      reply('pA', 2, 'rA'), // minha, só aqui: fica
      reply('pB-velha', 3, 'rB') // do B (pelo pedido, que só está no remoto), sumiu lá: sai
    ])
    const remote = central([
      req('rA', 1, A),
      req('rB', 1, B),
      reply('pA-apagada', 4, 'rA'), // minha, apagada aqui: continua fora
      reply('pB', 5, 'rB'), // do B: entra
      reply('orfa', 6, 'sumiu') // pedido em lugar nenhum: legado, entra pela união
    ])
    const out = mergeCentralConversation(local, remote, A)
    expect(ids(out)).toEqual(['rA', 'rB', 'pA', 'pB', 'orfa'])
  })

  it('a resposta com device próprio não herda: vale o device dela', () => {
    const local = central([req('rB', 1, B)])
    const remote = central([req('rB', 1, B), reply('pA', 2, 'rB', A)])
    // A resposta é do A (device), embora o pedido seja do B: some, porque não está aqui.
    expect(ids(mergeCentralConversation(local, remote, A))).toEqual(['rB'])
  })

  it('self desconhecido (null ou vazio): tudo conta como legado — união, a local vence', () => {
    const local = central([req('a1', 1, A, { text: 'local' })])
    const remote = central([req('a1', 1, A, { text: 'remota' }), req('a2', 2, A), req('b1', 3, B)])
    for (const self of [null, undefined, '']) {
      const out = mergeCentralConversation(local, remote, self)
      expect(ids(out)).toEqual(['a1', 'a2', 'b1'])
      expect(entry(out, 'a1')).toMatchObject({ text: 'local' })
    }
  })

  it('versões divergentes do mesmo id nunca duplicam nem somem', () => {
    // Donos diferentes nos dois lados (não deveria acontecer): fica UMA, a local.
    const cruzado = mergeCentralConversation(central([req('x', 1, A, { text: 'local' })]), central([req('x', 1, B)]), A)
    expect(ids(cruzado)).toEqual(['x'])
    expect(entry(cruzado, 'x')).toMatchObject({ text: 'local' })
    // A entrada ganhou dono do outro lado: é do B, vale a dele.
    const ganhou = mergeCentralConversation(central([req('y', 1)]), central([req('y', 1, B, { text: 'do B' })]), A)
    expect(ids(ganhou)).toEqual(['y'])
    expect(entry(ganhou, 'y')).toMatchObject({ text: 'do B' })
  })
})

describe('mergeCentralConversation — ordem, teto e o resto da conversa', () => {
  it('ordena por ts; empate fica na ordem local, depois na remota', () => {
    const local = central([req('x', 5), req('y', 3), req('y2', 3)])
    const remote = central([req('z', 3), req('w', 1)])
    expect(ids(mergeCentralConversation(local, remote, A))).toEqual(['w', 'y', 'y2', 'z', 'x'])
  })

  it('entrada do outro PC que já estava aqui conserva a posição local no empate', () => {
    const local = central([req('b1', 2, B), req('a1', 2, A)])
    const remote = central([req('a1', 2, A), req('b1', 2, B, { text: 'nova' })])
    const out = mergeCentralConversation(local, remote, A)
    expect(ids(out)).toEqual(['b1', 'a1'])
    expect(entry(out, 'b1')).toMatchObject({ text: 'nova' })
  })

  it('passou do teto: ficam as MAX_CENTRAL_ENTRIES mais novas', () => {
    const half = MAX_CENTRAL_ENTRIES - 100
    const local = central(Array.from({ length: half }, (_, i) => req(`a${i}`, i * 2, A)))
    const remote = central(Array.from({ length: half }, (_, i) => req(`b${i}`, i * 2 + 1, B)))
    const out = mergeCentralConversation(local, remote, A)
    expect(out.central?.entries).toHaveLength(MAX_CENTRAL_ENTRIES)
    // 2·half entradas intercaladas: saem as 2·half − MAX mais velhas.
    const cut = 2 * half - MAX_CENTRAL_ENTRIES
    expect(out.central?.entries[0]).toMatchObject({ ts: cut })
    expect(out.central?.entries.at(-1)).toMatchObject({ id: `b${half - 1}` })
  })

  it('o resto vem da local; updatedAt é o mais novo dos dois', () => {
    const local = central([req('a1', 1, A)], { model: 'claude-sonnet-5-5', draft: 'rascunho', updatedAt: 10 })
    const newer = central([req('b1', 2, B)], { model: 'outro', draft: 'do B', updatedAt: 20 })
    const out = mergeCentralConversation(local, newer, A)
    expect(out).toMatchObject({ model: 'claude-sonnet-5-5', draft: 'rascunho', updatedAt: 20, mode: 'central' })
    expect(mergeCentralConversation(local, central([req('b1', 2, B)], { updatedAt: 5 }), A).updatedAt).toBe(10)
  })

  it('Central ausente de um lado vale lista vazia', () => {
    const semLocal = mergeCentralConversation(central(undefined), central([req('b1', 1, B), req('l1', 2)]), A)
    expect(ids(semLocal)).toEqual(['b1', 'l1'])
    // Remoto sem Central: o B "não tem" entradas — as dele saem; as minhas e as de legado ficam.
    const semRemoto = mergeCentralConversation(central([req('a1', 1, A), req('b1', 2, B), req('l1', 3)]), central(undefined), A)
    expect(ids(semRemoto)).toEqual(['a1', 'l1'])
    expect(mergeCentralConversation(central(undefined), central(undefined), A).central?.entries ?? []).toEqual([])
  })

  it('não mexe nas entradas: nem nas conversas, nem nas listas, nem nos objetos', () => {
    const local = deepFreeze(central([req('a1', 3, A), req('b1', 1, B), req('l1', 2)]))
    const remote = deepFreeze(central([req('b1', 1, B, { text: 'nova' }), req('b2', 4, B), req('l2', 0)]))
    const before = JSON.stringify([local, remote])
    const out = mergeCentralConversation(local, remote, A)
    expect(JSON.stringify([local, remote])).toBe(before)
    expect(out).not.toBe(local)
    expect(out.central?.entries).not.toBe(local.central?.entries)
    expect(ids(out)).toEqual(['l2', 'b1', 'l1', 'a1', 'b2'])
  })

  it('nada a mudar: devolve a própria local (a tela não re-renderiza à toa)', () => {
    const local = central([req('a1', 1, A), req('l1', 2)])
    const remote = central([req('a1', 1, A, { text: 'velha' }), req('l1', 2, undefined, { text: 'remota' })], { updatedAt: 3 })
    expect(mergeCentralConversation(local, remote, A)).toBe(local)
  })
})
