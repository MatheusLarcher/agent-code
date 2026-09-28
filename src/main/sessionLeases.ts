/**
 * O lease de escrita de cada conversa com sessão viva, e o keeper que o renova.
 * Saiu do index.ts para duas garantias ficarem num lugar só (e testáveis):
 *
 * - Cada passo tem prazo (sessionSteps.ts): a aquisição falha sozinha em
 *   LEASE_ACQUIRE_DEADLINE_MS e o lease que chegar DEPOIS é solto quando
 *   chegar; a soltura espera no máximo LEASE_RELEASE_DEADLINE_MS e nunca falha.
 * - O keeper de uma operação nunca é sobrescrito pelo de outra: se, na volta da
 *   aquisição, a conversa já tem um keeper instalado, o que acabou de chegar
 *   não é instalado — é solto na hora. Todo lease adquirido e não instalado é
 *   solto.
 */
import type { ConversationLease, PersistenceRepository } from './persistence/types'
import { LEASE_ACQUIRE_DEADLINE_MS, LEASE_RELEASE_DEADLINE_MS, createStepRunner, type StepRunner } from './sessionSteps'

export type LeaseRepository = Pick<PersistenceRepository, 'acquireConversationLease' | 'releaseConversationLease'>

export interface LeaseKeeper {
  release(): Promise<void>
}

export interface SessionLeasesDeps<K extends LeaseKeeper, R extends LeaseRepository> {
  /** O repositório ATIVO (lança STORAGE_OFFLINE se não houver). */
  repository: () => R
  /** Monta e liga o keeper de `lease`. `isInstalled()` diz se ele ainda é o da
   *  conversa (o `onLost` de um keeper que já saiu não derruba ninguém). */
  keeper: (convId: string, lease: ConversationLease, isInstalled: () => boolean) => K
  steps?: StepRunner
}

/** Na volta da aquisição, a conversa já tinha outro keeper: o novo foi solto. */
export const LEASE_ALREADY_INSTALLED =
  'Outra operação já instalou o lease desta conversa durante a aquisição; o lease novo foi solto. Tente de novo.'

export class SessionLeases<K extends LeaseKeeper = LeaseKeeper, R extends LeaseRepository = LeaseRepository> {
  private readonly keepers = new Map<string, K>()
  private readonly steps: StepRunner

  constructor(private readonly deps: SessionLeasesDeps<K, R>) {
    this.steps = deps.steps ?? createStepRunner()
  }

  has(convId: string): boolean {
    return this.keepers.has(convId)
  }

  get(convId: string): K | undefined {
    return this.keepers.get(convId)
  }

  keys(): IterableIterator<string> {
    return this.keepers.keys()
  }

  values(): IterableIterator<K> {
    return this.keepers.values()
  }

  /** O keeper desta conversa saiu sozinho (lease perdido): esquece sem soltar.
   *  Só se ainda for ele o instalado. */
  forget(convId: string, keeper: K): void {
    if (this.keepers.get(convId) === keeper) this.keepers.delete(convId)
  }

  /** Solta o lease da conversa. Prazo próprio; estourado, segue (a soltura é
   *  cercada por token+epoch e o lease vence sozinho em 60 s). Nunca lança. */
  async release(convId: string): Promise<void> {
    const keeper = this.keepers.get(convId)
    if (!keeper) return
    this.keepers.delete(convId)
    await this.steps
      .run(`${convId}:lease-release`, 'A soltura do lease da conversa', LEASE_RELEASE_DEADLINE_MS, () => keeper.release())
      .catch((error: unknown) => console.warn(`[lease] soltura de ${convId}:`, error instanceof Error ? error.message : error))
  }

  /**
   * Solta o lease anterior, adquire um novo (prazo próprio) e o instala com o
   * keeper. Estourou o prazo: `StepDeadlineError`, nada instalado; o lease que
   * chegar tarde é solto. Chegou e a conversa já tem keeper: solta o novo e
   * lança LEASE_ALREADY_INSTALLED — o instalado fica.
   */
  async acquire(convId: string): Promise<{ repository: R; lease: ConversationLease }> {
    await this.release(convId)
    const repository = this.deps.repository()
    const releaseUnused = async (lease: ConversationLease): Promise<void> => {
      await repository.releaseConversationLease(lease).catch(() => undefined)
    }
    const lease = await this.steps.run(
      `${convId}:lease`,
      'A aquisição do lease da conversa',
      LEASE_ACQUIRE_DEADLINE_MS,
      () => repository.acquireConversationLease(convId),
      releaseUnused
    )
    if (this.keepers.has(convId)) {
      await releaseUnused(lease)
      throw new Error(LEASE_ALREADY_INSTALLED)
    }
    let keeper: K | undefined
    keeper = this.deps.keeper(convId, lease, () => !!keeper && this.keepers.get(convId) === keeper)
    this.keepers.set(convId, keeper)
    return { repository, lease }
  }
}
