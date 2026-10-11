import { describe, expect, it } from 'vitest'
import {
  clampLimit,
  detailsByIds,
  HISTORY_PAGE,
  HISTORY_PAGE_MAX,
  historyPage,
  historyWindow,
  LIGHT_RESULT_MAX,
  LIGHT_STRING_MAX,
  LIGHT_THINKING_MAX,
  lightenMessage,
  lightenMessages
} from './remoteHistory'

const msgs = (n: number): unknown[] => Array.from({ length: n }, (_, i) => ({ kind: 'user', id: `m${i}`, text: `msg ${i}` }))
const ids = (list: unknown[]): string[] => list.map((m) => (m as { id: string }).id)

describe('historyPage — páginas do histórico', () => {
  it('sem `before`: as últimas `limit` (padrão 50) e se há mais antigas', () => {
    const all = msgs(120)
    const page = historyPage(all, {})
    expect(page.messages).toHaveLength(HISTORY_PAGE)
    expect(ids(page.messages)[0]).toBe('m70')
    expect(ids(page.messages)[49]).toBe('m119')
    expect(page.hasOlder).toBe(true)
    expect(historyPage(msgs(10), {})).toEqual({ messages: msgs(10), hasOlder: false })
  })

  it('`before`: as `limit` anteriores à mensagem, e hasOlder só quando sobra algo', () => {
    const all = msgs(120)
    const p2 = historyPage(all, { before: 'm70' })
    expect(ids(p2.messages)).toEqual(ids(all.slice(20, 70)))
    expect(p2.hasOlder).toBe(true)
    const p3 = historyPage(all, { before: 'm20' })
    expect(ids(p3.messages)).toEqual(ids(all.slice(0, 20)))
    expect(p3.hasOlder).toBe(false)
  })

  it('`before` desconhecido: página vazia e sem mais antigas (nunca repete as últimas)', () => {
    expect(historyPage(msgs(5), { before: 'nope' })).toEqual({ messages: [], hasOlder: false })
  })

  it('limit: inteiro entre 1 e o teto; inválido vira a página padrão', () => {
    expect(clampLimit('10')).toBe(10)
    expect(clampLimit('999')).toBe(HISTORY_PAGE_MAX)
    expect(clampLimit('0')).toBe(HISTORY_PAGE)
    expect(clampLimit('abc')).toBe(HISTORY_PAGE)
    expect(clampLimit(null)).toBe(HISTORY_PAGE)
    expect(historyPage(msgs(300), { limit: 5000 }).messages).toHaveLength(HISTORY_PAGE_MAX)
  })
})

describe('historyWindow — a janela do mapa de perguntas', () => {
  it('centra na mensagem e diz se há mais antigas e mais novas', () => {
    const all = msgs(100)
    const w = historyWindow(all, 'm50')!
    expect(ids(w.messages)[0]).toBe('m38')
    expect(ids(w.messages)[w.messages.length - 1]).toBe('m67')
    expect(w).toMatchObject({ targetId: 'm50', hasOlder: true, hasNewer: true })
    expect(historyWindow(all, 'm2')!.hasOlder).toBe(false)
    expect(historyWindow(all, 'm95')!.hasNewer).toBe(false)
    expect(historyWindow(all, 'zzz')).toBeNull()
  })
})

describe('lightenMessages — a versão leve', () => {
  const big = 'x'.repeat(5000)

  it('corta entrada e resultado da ferramenta e marca light; o pequeno fica como está (mesma referência)', () => {
    const small = { kind: 'tool-use', id: 't1', name: 'Read', input: { file_path: 'a.ts' }, result: { isError: false, text: 'ok' } }
    const heavy = { kind: 'tool-use', id: 't2', name: 'Write', input: { file_path: 'b.ts', content: big }, result: { isError: false, text: big } }
    const [s, h] = lightenMessages([small, heavy]) as Array<{ light?: boolean; input: Record<string, string>; result: { text: string } }>
    expect(s).toBe(small)
    expect(h.light).toBe(true)
    expect(h.input.file_path).toBe('b.ts')
    expect(h.input.content).toHaveLength(LIGHT_STRING_MAX + 1)
    expect(h.result.text).toHaveLength(LIGHT_RESULT_MAX + 1)
    expect((heavy.input as { content: string }).content).toHaveLength(5000) // a original não muda
  })

  it('corta strings dentro de listas e objetos aninhados da entrada', () => {
    const m = { kind: 'tool-use', id: 't', name: 'MultiEdit', input: { edits: [{ old_string: 'a', new_string: big }] } }
    const out = lightenMessage(m) as { light?: boolean; input: { edits: Array<{ new_string: string }> } }
    expect(out.light).toBe(true)
    expect(out.input.edits[0].new_string.length).toBe(LIGHT_STRING_MAX + 1)
  })

  it('o pensamento longo é cortado; o texto do agente e a mensagem do usuário vão inteiros', () => {
    const think = { kind: 'thinking', id: 'th', text: big }
    const answer = { kind: 'assistant-text', id: 'a', text: big, final: true, answer: true }
    const user = { kind: 'user', id: 'u', text: big }
    const [t, a, u] = lightenMessages([think, answer, user])
    expect((t as { light?: boolean; text: string }).light).toBe(true)
    expect((t as { text: string }).text).toHaveLength(LIGHT_THINKING_MAX + 1)
    expect(a).toBe(answer)
    expect(u).toBe(user)
  })

  it('detailsByIds devolve as mensagens inteiras pedidas, na ordem da conversa', () => {
    const all = [{ kind: 'user', id: 'u1' }, { kind: 'tool-use', id: 't1', input: { content: big } }, { kind: 'tool-use', id: 't2' }]
    expect(detailsByIds(all, ['t2', 't1', 'nope'])).toEqual([all[1], all[2]])
    expect(detailsByIds(all, [])).toEqual([])
  })
})
