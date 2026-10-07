import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { HandoffQueueDecision } from '@shared/handoffTracking'
import type { Conversation } from '../types'
import { createHandoffQueueDispatcher, useHandoffQueue, type HandoffQueueDeps } from './handoffQueue'
import { launchHandoff } from './handoffFlow'

/**
 * O despachante da fila do quadro no renderer: pergunta ao main (a decisão mora
 * lá) e despacha pelo `dispatch` do App, só com a conversa ociosa e a fila do
 * chat vazia — o que o usuário digita tem prioridade.
 */

afterEach(cleanup)

const conv = (over: Partial<Conversation> = {}): Conversation =>
  ({ id: 'c1', title: 'Implementação: Plano', cwd: 'C:/p', messages: [], handoffSlug: 'plano', ...over }) as Conversation

const next: HandoffQueueDecision = {
  kind: 'next',
  envio: { id: 'env-2', conversationId: 'c1', loteId: 'l1', ordem: 2, arquivo: '02.md', conteudo: 'Prompt 2' }
}
const hold: HandoffQueueDecision = { kind: 'hold', envio: next.envio, motivo: 'o prompt anterior não foi concluído: faltou [b]' }

function setup(over: Partial<HandoffQueueDeps> = {}, decision: HandoffQueueDecision = next) {
  const conversations = new Map([['c1', conv()]])
  const api = {
    handoffQueueGate: vi.fn(async (req: { conversationId: string; force?: boolean }) => ({
      ok: true as const,
      decision: req.force && decision.kind === 'hold' ? { kind: 'next' as const, envio: decision.envio } : decision
    })),
    handoffQueueDispatched: vi.fn(async () => ({ ok: true as const, dispatched: true }))
  }
  const deps: HandoffQueueDeps = {
    api,
    conversation: (id) => conversations.get(id),
    idle: vi.fn(() => true),
    waitTurnEnd: vi.fn(async () => undefined),
    dispatch: vi.fn(async () => undefined),
    onHold: vi.fn(),
    ...over
  }
  return { deps, api, conversations, dispatcher: createHandoffQueueDispatcher(deps) }
}

describe('createHandoffQueueDispatcher', () => {
  it('anterior concluído → marca pelo id e manda pelo dispatch do App', async () => {
    const { deps, api, dispatcher } = setup()
    await dispatcher.check('c1')
    expect(deps.waitTurnEnd).toHaveBeenCalledWith('c1')
    expect(api.handoffQueueGate).toHaveBeenCalledWith({ conversationId: 'c1' })
    expect(api.handoffQueueDispatched).toHaveBeenCalledWith({ conversationId: 'c1', envioId: 'env-2' })
    expect(deps.dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'Prompt 2')
  })

  it('anterior não concluído → para com o motivo e não manda nada; "Enviar mesmo assim" manda', async () => {
    const { deps, api, dispatcher } = setup({}, hold)
    await dispatcher.check('c1')
    expect(deps.onHold).toHaveBeenCalledWith('c1', hold.motivo)
    expect(api.handoffQueueDispatched).not.toHaveBeenCalled()
    expect(deps.dispatch).not.toHaveBeenCalled()

    expect(await dispatcher.sendAnyway('c1')).toBe(true)
    expect(api.handoffQueueGate).toHaveBeenLastCalledWith({ conversationId: 'c1', force: true })
    expect(deps.dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'Prompt 2')
  })

  it('conversa ocupada ou com mensagem do usuário na fila do chat: nem pergunta ao main', async () => {
    const { deps, api, dispatcher } = setup({ idle: vi.fn(() => false) })
    await dispatcher.check('c1')
    expect(api.handoffQueueGate).not.toHaveBeenCalled()
    expect(deps.dispatch).not.toHaveBeenCalled()
  })

  it('o usuário mandou algo enquanto o main decidia: a mensagem dele vence, o prompt espera', async () => {
    let idle = true
    const { deps, api, dispatcher } = setup({ idle: () => idle })
    api.handoffQueueGate.mockImplementationOnce(async () => {
      idle = false // o usuário digitou no meio da espera
      return { ok: true as const, decision: next }
    })
    await dispatcher.check('c1')
    expect(api.handoffQueueDispatched).not.toHaveBeenCalled()
    expect(deps.dispatch).not.toHaveBeenCalled()
  })

  it('conversa que não é de implantação (inclusive tarefa do Forgia/MCP): nada muda', async () => {
    const { deps, api, conversations, dispatcher } = setup()
    conversations.set('c1', conv({ handoffSlug: undefined }))
    await dispatcher.check('c1')
    expect(api.handoffQueueGate).not.toHaveBeenCalled()
    expect(deps.dispatch).not.toHaveBeenCalled()
  })

  it('outra conferência mandou antes (dispatched: false): não manda de novo', async () => {
    const { deps, api, dispatcher } = setup()
    api.handoffQueueDispatched.mockResolvedValueOnce({ ok: true as const, dispatched: false })
    await dispatcher.check('c1')
    expect(deps.dispatch).not.toHaveBeenCalled()
  })

  it('pedidos no meio de uma conferência viram UMA repetição no fim', async () => {
    let release!: () => void
    const { api, dispatcher } = setup({}, { kind: 'none' })
    api.handoffQueueGate.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ ok: true as const, decision: { kind: 'none' as const } })))
    )
    const first = dispatcher.check('c1')
    void dispatcher.check('c1')
    void dispatcher.check('c1')
    await waitFor(() => expect(api.handoffQueueGate).toHaveBeenCalledTimes(1))
    release()
    await first
    await waitFor(() => expect(api.handoffQueueGate).toHaveBeenCalledTimes(2))
  })
})

describe('useHandoffQueue — anda sozinha e retoma na abertura', () => {
  function hookDeps(base: ReturnType<typeof setup>) {
    let changed: ((msg: { conversationId: string }) => void) | null = null
    const api = {
      ...base.api,
      handoffQueueList: vi.fn(async () => ({
        ok: true as const,
        items: [{ conversationId: 'c1' }, { conversationId: 'c1' }] as never
      })),
      onHandoffChanged: vi.fn((cb: (msg: { conversationId: string }) => void) => {
        changed = cb
        return () => undefined
      })
    }
    return { deps: { ...base.deps, api }, api, emitChanged: (id: string) => changed?.({ conversationId: id }) }
  }

  it('na abertura (hidratado), confere cada conversa com prompt esperando no banco — uma vez por conversa', async () => {
    const base = setup()
    const { deps, api } = hookDeps(base)
    const { rerender } = renderHook(({ hydrated }) => useHandoffQueue(hydrated, deps), { initialProps: { hydrated: false } })
    expect(api.handoffQueueList).not.toHaveBeenCalled()
    rerender({ hydrated: true })
    await waitFor(() => expect(base.deps.dispatch).toHaveBeenCalledTimes(1))
    expect(api.handoffQueueGate).toHaveBeenCalledTimes(1)
  })

  it('handoff:changed (o anterior concluiu depois) confere a conversa e manda o próximo', async () => {
    const base = setup()
    const { deps, emitChanged } = hookDeps(base)
    renderHook(() => useHandoffQueue(false, deps))
    emitChanged('c1')
    await waitFor(() => expect(base.deps.dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), 'Prompt 2'))
  })
})

describe('launchHandoff — fila do quadro e do projeto', () => {
  const create = (): { id: string } => ({ id: 'c1' })

  it('registro feito: nenhum sai pelo envio direto; todos esperam no banco e a fila é conferida (o 1º sai na vez do plano)', async () => {
    const send = vi.fn(async () => true)
    const kick = vi.fn()
    const res = await launchHandoff(['P1', 'P2', 'P3'], { create, send, register: async () => undefined, queueInBoard: true, kick })
    expect(send).not.toHaveBeenCalled()
    expect(kick).toHaveBeenCalledWith({ id: 'c1' })
    expect(res).toEqual({ conv: { id: 'c1' }, delivered: 3, total: 3, queued: 3 })
  })

  it('a conferência que lança não derruba o envio: o main avisa de novo (handoff:changed, abertura)', async () => {
    const res = await launchHandoff(['P1'], {
      create,
      send: async () => true,
      register: async () => undefined,
      queueInBoard: true,
      kick: () => {
        throw new Error('sem despachante')
      }
    })
    expect(res).toEqual({ conv: { id: 'c1' }, delivered: 1, total: 1, queued: 1 })
  })

  it('registro falhou: todos pelo envio de sempre (a fila do chat), para nada se perder', async () => {
    const send = vi.fn(async () => true)
    const onRegisterError = vi.fn()
    const res = await launchHandoff(['P1', 'P2'], {
      create,
      send,
      register: async () => {
        throw new Error('banco fora')
      },
      onRegisterError,
      queueInBoard: true
    })
    expect(onRegisterError).toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(2)
    expect(res).toEqual({ conv: { id: 'c1' }, delivered: 2, total: 2 })
  })

  it('sem a fila do quadro (registro falhou), o 1º que não saiu para os demais', async () => {
    const send = vi.fn(async () => false)
    const res = await launchHandoff(['P1', 'P2'], {
      create,
      send,
      register: async () => {
        throw new Error('banco fora')
      },
      queueInBoard: true
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ conv: { id: 'c1' }, delivered: 0, total: 2 })
  })
})
