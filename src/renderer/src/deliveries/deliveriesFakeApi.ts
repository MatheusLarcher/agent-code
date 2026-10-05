import { act } from '@testing-library/react'
import { vi } from 'vitest'
import type {
  HandoffChangedMsg,
  HandoffCorrectEntregaRequest,
  HandoffCorrectEntregaResult,
  HandoffListRequest,
  HandoffListResult
} from '@shared/api'
import type { HandoffEnvio } from '@shared/handoffTracking'

/**
 * handoff:list, handoff:correctEntrega e handoff:changed em memória, para os
 * testes das Entregas (não é teste). O "banco" é `world.envios`; `changed()`
 * dispara o aviso como o main faria depois de gravar.
 */
export function fakeDeliveriesApi(initial: HandoffEnvio[]) {
  const world = { envios: structuredClone(initial) }
  const listeners = new Set<(msg: HandoffChangedMsg) => void>()
  const api = {
    handoffList: vi.fn(
      async (req?: HandoffListRequest): Promise<HandoffListResult> => ({
        ok: true,
        envios: structuredClone(world.envios.filter((e) => !req?.conversationId || e.conversationId === req.conversationId))
      })
    ),
    handoffCorrectEntrega: vi.fn(async (req: HandoffCorrectEntregaRequest): Promise<HandoffCorrectEntregaResult> => {
      const envio = world.envios.find((e) => e.entregas.some((x) => x.id === req.entregaId))
      if (!envio) return { ok: false, message: 'Entrega não encontrada.' }
      envio.entregas = envio.entregas.map((x) =>
        x.id === req.entregaId
          ? { ...x, status: req.acao === 'concluir' ? 'concluida' : 'pendente', corrigidoPor: 'usuario', corrigidoEm: '2026-10-05T13:00:00.000Z' }
          : x
      )
      return { ok: true, envio: structuredClone(envio) }
    }),
    onHandoffChanged: vi.fn((cb: (msg: HandoffChangedMsg) => void) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    })
  }
  /** Troca o "banco" e avisa (como o main depois de gravar). */
  const change = async (envios: HandoffEnvio[], conversationId = 'conv-1'): Promise<void> => {
    world.envios = structuredClone(envios)
    await act(async () => {
      for (const cb of listeners) cb({ conversationId })
    })
  }
  return { api, world, change, listeners }
}
