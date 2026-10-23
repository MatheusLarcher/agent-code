import { describe, expect, it } from 'vitest'
import { RemoteLightDiff, type RemoteLightInputs } from './remoteLightDiff'

type C = { id: string; title: string }
const item = (conv: C, extra: Partial<RemoteLightInputs<C>> = {}): RemoteLightInputs<C> => ({
  conv,
  busy: false,
  connected: false,
  queued: '',
  permission: undefined,
  stalled: undefined,
  central: null,
  ...extra
})

describe('RemoteLightDiff — só o que mudou vai para o celular', () => {
  it('na primeira vez (ou com `all`) manda tudo; depois só a conversa que mudou de identidade ou de estado', () => {
    const diff = new RemoteLightDiff<C>()
    const a = { id: 'a', title: 'A' }
    const b = { id: 'b', title: 'B' }
    expect(diff.diff([item(a), item(b)], true).changed.map((i) => i.conv.id)).toEqual(['a', 'b'])
    expect(diff.diff([item(a), item(b)], false).changed).toEqual([])
    // Streaming na conversa A: novo objeto; B só ficou ocupada.
    const a2 = { ...a, title: 'A com resposta' }
    expect(diff.diff([item(a2), item(b, { busy: true })], false).changed.map((i) => i.conv.id)).toEqual(['a', 'b'])
    expect(diff.diff([item(a2), item(b, { busy: true, permission: { id: 'p1' } })], false).changed.map((i) => i.conv.id)).toEqual(['b'])
  })

  it('conversa que saiu da lista vira `removed`; com `all` a lista inteira já vale', () => {
    const diff = new RemoteLightDiff<C>()
    const a = { id: 'a', title: 'A' }
    const b = { id: 'b', title: 'B' }
    diff.diff([item(a), item(b)], true)
    expect(diff.diff([item(a)], false)).toEqual({ changed: [], removed: ['b'] })
    expect(diff.diff([item(a)], true)).toEqual({ changed: [item(a)], removed: [] })
  })

  it('o início e o fim da compactação mandam a conversa de novo (o aviso ao vivo do celular)', () => {
    const diff = new RemoteLightDiff<C>()
    const a = { id: 'a', title: 'A' }
    diff.diff([item(a, { busy: true })], true)
    expect(diff.diff([item(a, { busy: true, compacting: 1000 })], false).changed).toHaveLength(1)
    expect(diff.diff([item(a, { busy: true, compacting: 1000 })], false).changed).toHaveLength(0)
    expect(diff.diff([item(a, { busy: true })], false).changed).toHaveLength(1)
  })

  it('cada nova tentativa da API e o fim dela mandam a conversa de novo (a linha ao vivo do celular)', () => {
    const diff = new RemoteLightDiff<C>()
    const a = { id: 'a', title: 'A' }
    const r1 = { attempt: 1, maxRetries: 10, retryAt: 5000, status: 529, error: 'overloaded' }
    diff.diff([item(a, { busy: true })], true)
    expect(diff.diff([item(a, { busy: true, apiRetry: r1 })], false).changed).toHaveLength(1)
    expect(diff.diff([item(a, { busy: true, apiRetry: r1 })], false).changed).toHaveLength(0)
    expect(diff.diff([item(a, { busy: true, apiRetry: { ...r1, attempt: 2 } })], false).changed).toHaveLength(1)
    expect(diff.diff([item(a, { busy: true })], false).changed).toHaveLength(1)
  })

  it('sugestão do próximo prompt chegando, trocada ou tirada manda a conversa de novo (o chip do celular)', () => {
    const diff = new RemoteLightDiff<C>()
    const a = { id: 'a', title: 'A' }
    diff.diff([item(a)], true)
    expect(diff.diff([item(a, { suggestion: 'Rode os testes' })], false).changed).toHaveLength(1)
    expect(diff.diff([item(a, { suggestion: 'Rode os testes' })], false).changed).toHaveLength(0)
    expect(diff.diff([item(a, { suggestion: 'Faça o commit' })], false).changed).toHaveLength(1)
    expect(diff.diff([item(a)], false).changed).toHaveLength(1)
  })

  it('subagente entrando, resumo novo e o fim deles mandam a conversa de novo (a faixa do celular)', () => {
    const diff = new RemoteLightDiff<C>()
    const a = { id: 'a', title: 'A' }
    diff.diff([item(a, { busy: true })], true)
    expect(diff.diff([item(a, { busy: true, subagents: 't1\u0000Executor\u0000' })], false).changed).toHaveLength(1)
    expect(diff.diff([item(a, { busy: true, subagents: 't1\u0000Executor\u0000' })], false).changed).toHaveLength(0)
    expect(diff.diff([item(a, { busy: true, subagents: 't1\u0000Executor\u0000Rodando os testes' })], false).changed).toHaveLength(1)
    expect(diff.diff([item(a, { busy: true, subagents: '' })], false).changed).toHaveLength(1)
    expect(diff.diff([item(a, { busy: true })], false).changed).toHaveLength(0)
  })

  it('a config do Agent Manager trocada (modelKey) e o invalidate (pedido recusado) mandam a conversa de novo', () => {
    const diff = new RemoteLightDiff<C>()
    const a = { id: 'a', title: 'A' }
    diff.diff([item(a, { modelKey: 'opus|high' })], true)
    expect(diff.diff([item(a, { modelKey: 'opus|high' })], false).changed).toHaveLength(0)
    expect(diff.diff([item(a, { modelKey: 'opus|max' })], false).changed).toHaveLength(1)
    diff.invalidate('a')
    expect(diff.diff([item(a, { modelKey: 'opus|max' })], false).changed).toHaveLength(1)
    expect(diff.diff([item(a, { modelKey: 'opus|max' })], false).changed).toHaveLength(0)
  })
})
