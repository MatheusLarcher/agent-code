import { z } from 'zod'
import type { PoAuthorization, PoAuthorizationMap } from '../../shared/poAuthorization'
import { Channels } from '../../shared/ipc'
import { authorizationExpired, conversationQueue, queueRoutine } from '../handoffTracking/handoffRoutine'
import type { HandoffRepository } from '../persistence/types'
import type { PoRoutineRequest } from './poApply'
import { PoAuthorizationStore, routineText, type PoAuthorizationOp } from './poAuthorization'

/**
 * A montagem da autorização do PO para o index.ts: a chave do banco, as pontes
 * que o PO usa (ler, gravar com a barreira "fila só com fila", pôr a rotina na
 * fila), o fim do alcance "desta fila" e os canais do chip.
 */

export const PO_AUTHORIZATIONS_KEY = 'agentcode.po-authorizations.v1'

export interface PoAuthorizationBootDeps {
  repository(): HandoffRepository | null
  read(key: string): Promise<string | null>
  write(key: string, value: string): Promise<void>
  /** A foto nova das autorizações para a tela (po:authorizationsChanged). */
  publish(map: PoAuthorizationMap): void
  /** Avisa a tela e o despachante (handoff:changed). */
  changed(conversationId: string): void
  now?(): number
}

export type IpcHandle = (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void

const RevokeReq = z.strictObject({ conversationId: z.string().min(1).max(200) })

export function createPoAuthorizations(deps: PoAuthorizationBootDeps) {
  const store = new PoAuthorizationStore({
    read: () => deps.read(PO_AUTHORIZATIONS_KEY),
    write: (value) => deps.write(PO_AUTHORIZATIONS_KEY, value),
    changed: deps.publish
  })
  const envios = async (conversationId: string) => (await deps.repository()?.listHandoffEnvios({ conversationId })) ?? []

  return {
    store,

    /** O que o digest do PO lê: a autorização e se a conversa tem fila. */
    async authorization(conversationId: string): Promise<{ current: PoAuthorization | null; hasQueue: boolean }> {
      const [current, list] = await Promise.all([store.get(conversationId), envios(conversationId)])
      return { current, hasQueue: conversationQueue(list).hasQueue }
    },

    /** AUTORIZAR/REVOGAR da abertura. Sem fila, o alcance "fila" é pedido normal: não autoriza. */
    async authorize(conversationId: string, op: PoAuthorizationOp): Promise<void> {
      if (op.kind === 'revogar') return store.set(conversationId, null)
      const queue = conversationQueue(await envios(conversationId))
      if (op.scope === 'fila' && !queue.hasQueue) return
      await store.set(conversationId, {
        push: op.push,
        scope: op.scope,
        at: new Date(deps.now?.() ?? Date.now()).toISOString(),
        loteId: op.scope === 'fila' ? queue.loteId : null
      })
    },

    /** A pendência de commit autorizada: o texto fixo, só com o título do cartão. */
    async queueRoutine(conversationId: string, routine: PoRoutineRequest): Promise<void> {
      await queueRoutine(
        { repository: deps.repository, changed: deps.changed },
        { conversationId, conversationTitle: 'Conversa', cwd: routine.cwd, projectId: routine.projectId, text: routineText(routine.title, routine.push) }
      )
    },

    /** O alcance "desta fila" acaba sozinho quando a fila da implantação esvazia. */
    async expire(conversationId: string): Promise<void> {
      const current = await store.get(conversationId)
      if (current && authorizationExpired(current, await envios(conversationId))) await store.set(conversationId, null)
    },

    /** Os canais do chip: a foto e o "Revogar". Nada lança. */
    registerIpc(handle: IpcHandle): void {
      handle(Channels.poAuthorizationList, async () => {
        try {
          return { ok: true, authorizations: await store.all() }
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : String(err) }
        }
      })
      handle(Channels.poAuthorizationRevoke, async (_event, payload) => {
        const parsed = RevokeReq.safeParse(payload)
        if (!parsed.success) return { ok: false, message: 'pedido inválido' }
        try {
          await store.set(parsed.data.conversationId, null)
          return { ok: true }
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : String(err) }
        }
      })
    }
  }
}
