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
})
