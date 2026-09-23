import { describe, expect, it } from 'vitest'
import { PO_MAX_CALLS, PO_MAX_USER_CHARS, type PoCall } from './poPrompt'
import { defer, joinRequests, mergeDeferred, restoreDeferred, type PoDeferred, type PoTurnSnapshot } from './poQueue'

function calls(prefix: string, count: number): PoCall[] {
  return Array.from({ length: count }, (_, index) => ({ tool: 'Bash', detail: `${prefix}${index}` }))
}

function turn(userText: string, turnCalls: PoCall[] = [], cwd = 'C:/proj'): PoTurnSnapshot {
  return Object.freeze({ userText, cwd, calls: Object.freeze([...turnCalls]) })
}

describe('joinRequests', () => {
  it('um pedido só vai sem numeração, e nenhum vira texto vazio', () => {
    expect(joinRequests([])).toBe('')
    expect(joinRequests(['arruma o login'])).toBe('arruma o login')
  })

  it('vários pedidos saem numerados, para o modelo não ler a emenda como um só', () => {
    expect(joinRequests(['a', 'b', 'c'])).toBe('(1) a (2) b (3) c')
  })
})

describe('defer', () => {
  it('cria a fila quando não havia nenhuma e não mexe na que recebeu', () => {
    const first = defer(null, turn('um', calls('x', 2)))
    expect(first).toEqual({ texts: ['um'], calls: calls('x', 2) })

    const snapshot = structuredClone(first)
    const second = defer(first, turn('dois', calls('y', 1)))
    expect(second.texts).toEqual(['um', 'dois'])
    expect(second.calls).toEqual([...calls('x', 2), ...calls('y', 1)])
    expect(first).toEqual(snapshot)
  })

  it('aplica os tetos do digest descartando do mais antigo', () => {
    const big = 'a'.repeat(PO_MAX_USER_CHARS)
    const queue = defer(defer(null, turn(big, calls('old', PO_MAX_CALLS))), turn('novo', calls('new', 3)))
    expect(queue.texts).toEqual(['novo'])
    expect(queue.calls).toHaveLength(PO_MAX_CALLS)
    expect(queue.calls.slice(-3)).toEqual(calls('new', 3))
  })
})

describe('mergeDeferred', () => {
  it('sem fila (ou com fila vazia) devolve o próprio turno', () => {
    const now = turn('agora')
    expect(mergeDeferred(null, now)).toBe(now)
    expect(mergeDeferred({ texts: [], calls: [] }, now)).toBe(now)
  })

  it('junta o acumulado antes do turno de agora e ignora pedidos em branco', () => {
    const merged = mergeDeferred({ texts: ['antes', '  '], calls: calls('a', 1) }, turn('agora', calls('b', 1)))
    expect(merged.userText).toBe('(1) antes (2) agora')
    expect(merged.calls).toEqual([...calls('a', 1), ...calls('b', 1)])
    expect(Object.isFrozen(merged)).toBe(true)
  })

  it('o pedido de agora sobrevive ao teto mesmo quando o acumulado sozinho já o estoura', () => {
    const merged = mergeDeferred({ texts: ['x'.repeat(PO_MAX_USER_CHARS)], calls: [] }, turn('agora'))
    expect(merged.userText).toBe('agora')
  })

  it('nas ações ficam as mais recentes', () => {
    const merged = mergeDeferred({ texts: ['antes'], calls: calls('old', PO_MAX_CALLS) }, turn('agora', calls('new', 2)))
    expect(merged.calls).toHaveLength(PO_MAX_CALLS)
    expect(merged.calls.slice(-2)).toEqual(calls('new', 2))
  })

  it('só com o turno vazio de um flush devolve o acumulado, sem pedido novo', () => {
    const merged = mergeDeferred({ texts: ['pendente'], calls: [] }, turn(''))
    expect(merged.userText).toBe('pendente')
  })
})

describe('restoreDeferred', () => {
  it('sem nada a devolver, a fila fica como estava — inclusive null', () => {
    const queue: PoDeferred = { texts: ['q'], calls: [] }
    expect(restoreDeferred(null, { texts: [], calls: [] })).toBeNull()
    expect(restoreDeferred(queue, { texts: [], calls: [] })).toBe(queue)
  })

  it('o que volta é mais antigo e entra na frente do que chegou durante a análise', () => {
    const queue: PoDeferred = { texts: ['durante'], calls: calls('d', 1) }
    const snapshot = structuredClone(queue)
    const restored = restoreDeferred(queue, { texts: ['antes'], calls: calls('a', 1) })
    expect(restored).toEqual({ texts: ['antes', 'durante'], calls: [...calls('a', 1), ...calls('d', 1)] })
    expect(queue).toEqual(snapshot)
  })

  it('os mesmos tetos continuam valendo na devolução', () => {
    const restored = restoreDeferred(
      { texts: ['durante'], calls: calls('d', 2) },
      { texts: ['a'.repeat(PO_MAX_USER_CHARS)], calls: calls('a', PO_MAX_CALLS) }
    )
    expect(restored?.texts).toEqual(['durante'])
    expect(restored?.calls).toHaveLength(PO_MAX_CALLS)
    expect(restored?.calls.slice(-2)).toEqual(calls('d', 2))
  })
})
