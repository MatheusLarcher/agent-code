import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { PoAuthorizationMap } from '@shared/poAuthorization'
import type { Conversation } from '../types'
import { createHandoffQueueDispatcher } from './handoffQueue'
import { PoAuthChip, usePoAuthorizations, type PoAuthApi } from './PoAuthChip'

/**
 * O chip da autorização do PO: sempre visível enquanto vale, com "Revogar" a
 * um clique; e a conversa sem plano, autorizada "sempre", também tem a rotina
 * de commit despachada pela fila.
 */

afterEach(cleanup)

function fakeApi(initial: PoAuthorizationMap = {}) {
  let push: ((map: PoAuthorizationMap) => void) | null = null
  const api = {
    poAuthorizationList: vi.fn(async () => ({ ok: true as const, authorizations: initial })),
    poAuthorizationRevoke: vi.fn(async () => ({ ok: true as const })),
    onPoAuthorizationsChanged: vi.fn((cb: (map: PoAuthorizationMap) => void) => {
      push = cb
      return () => undefined
    })
  } satisfies PoAuthApi
  return { api, emit: (map: PoAuthorizationMap) => push?.(map) }
}

describe('PoAuthChip', () => {
  it('mostra o alcance e revoga pelo chip', async () => {
    const { api } = fakeApi()
    render(<PoAuthChip conversationId="c1" authorization={{ push: true, scope: 'fila', at: 'x' }} api={api} />)
    fireEvent.click(screen.getByRole('button', { name: 'PO autorizado: commit + push · esta fila' }))
    fireEvent.click(screen.getByRole('button', { name: 'Revogar' }))
    await waitFor(() => expect(api.poAuthorizationRevoke).toHaveBeenCalledWith({ conversationId: 'c1' }))
    cleanup()
    render(<PoAuthChip conversationId="c1" authorization={{ push: false, scope: 'sempre', at: 'x' }} api={api} />)
    expect(screen.getByRole('button', { name: 'PO autorizado: commit · sempre' })).toBeTruthy()
    cleanup()
    const { container } = render(<PoAuthChip conversationId="c1" authorization={null} api={api} />)
    expect(container.innerHTML).toBe('')
  })

  it('usePoAuthorizations lê a foto e acompanha o main (o chip some quando a fila esvazia)', async () => {
    const { api, emit } = fakeApi({ c1: { push: true, scope: 'fila', at: 'x' } })
    const { result } = renderHook(() => usePoAuthorizations(api))
    await waitFor(() => expect(result.current.c1?.scope).toBe('fila'))
    act(() => emit({}))
    expect(result.current.c1).toBeUndefined()
  })
})

describe('a rotina numa conversa sem plano ("sempre")', () => {
  it('o despachante pergunta ao main e manda o texto fixo', async () => {
    const conv = { id: 'c1', title: 'Conversa', cwd: 'C:/p', messages: [] } as unknown as Conversation
    const dispatch = vi.fn(async () => undefined)
    const deps = {
      api: {
        handoffQueueGate: vi.fn(async () => ({
          ok: true as const,
          decision: { kind: 'next' as const, envio: { id: 'r1', conversationId: 'c1', loteId: 'rotina-c1', ordem: 1, arquivo: 'rotina-po', conteudo: 'Faça o commit das mudanças de: X.' } }
        })),
        handoffQueueDispatched: vi.fn(async () => ({ ok: true as const, dispatched: true }))
      },
      conversation: () => conv,
      idle: () => true,
      waitTurnEnd: async () => undefined,
      dispatch
    }
    // Sem autorização: conversa comum, nada a conferir.
    await createHandoffQueueDispatcher(deps).check('c1')
    expect(deps.api.handoffQueueGate).not.toHaveBeenCalled()
    await createHandoffQueueDispatcher({ ...deps, queueCapable: () => true }).check('c1')
    expect(dispatch).toHaveBeenCalledWith(conv, 'Faça o commit das mudanças de: X.')
  })
})
