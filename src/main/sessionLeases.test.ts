import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationLease } from './persistence/types'
import { LEASE_ALREADY_INSTALLED, SessionLeases, type LeaseKeeper, type LeaseRepository } from './sessionLeases'
import { LEASE_ACQUIRE_DEADLINE_MS, StepDeadlineError } from './sessionSteps'

const lease = (token: string): ConversationLease =>
  ({ conversationId: 'c1', ownerInstallationId: 'eu', token, fencingEpoch: 1, expiresAt: '' }) as ConversationLease

type TestKeeper = LeaseKeeper & { token: string; isInstalled: () => boolean }

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function harness() {
  const gates: Array<{ resolve: (l: ConversationLease) => void }> = []
  const repo = {
    acquireConversationLease: vi.fn(
      () => new Promise<ConversationLease>((resolve) => gates.push({ resolve }))
    ),
    releaseConversationLease: vi.fn(async () => undefined)
  }
  const keepers: TestKeeper[] = []
  const leases = new SessionLeases({
    repository: () => repo as unknown as LeaseRepository,
    keeper: (_convId, held, isInstalled) => {
      const k: TestKeeper = { token: held.token, isInstalled, release: vi.fn(async () => undefined) }
      keepers.push(k)
      return k
    }
  })
  return { repo, gates, keepers, leases }
}

describe('SessionLeases', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('instala o keeper do lease adquirido', async () => {
    const { gates, keepers, leases } = harness()
    const acquiring = leases.acquire('c1')
    await flush()
    gates[0].resolve(lease('A'))
    await acquiring
    expect(leases.get('c1')).toBe(keepers[0])
    expect(keepers[0].isInstalled()).toBe(true)
  })

  it('nunca sobrescreve o keeper de outra operação: o lease que chega depois NÃO é instalado e é solto', async () => {
    const { repo, gates, keepers, leases } = harness()
    const first = leases.acquire('c1')
    const second = leases.acquire('c1')
    await flush()
    // A primeira instala o dela…
    gates[0].resolve(lease('A'))
    await first
    // …e a segunda volta depois: já há keeper instalado.
    gates[1].resolve(lease('B'))
    await expect(second).rejects.toThrow(LEASE_ALREADY_INSTALLED)
    expect(leases.get('c1')).toBe(keepers[0])
    expect(keepers).toHaveLength(1)
    expect(repo.releaseConversationLease).toHaveBeenCalledWith(expect.objectContaining({ token: 'B' }))
    expect(repo.releaseConversationLease).not.toHaveBeenCalledWith(expect.objectContaining({ token: 'A' }))
  })

  it('aquisição presa: falha no prazo sem instalar nada; o lease que chega tarde é solto; a próxima espera por ele', async () => {
    vi.useFakeTimers()
    const { repo, gates, keepers, leases } = harness()
    const stuck = leases.acquire('c1').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(LEASE_ACQUIRE_DEADLINE_MS)
    expect(await stuck).toBeInstanceOf(StepDeadlineError)
    expect(leases.has('c1')).toBe(false)
    // A próxima aquisição da conversa não vai ao banco com a atrasada ainda lá.
    const next = leases.acquire('c1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(repo.acquireConversationLease).toHaveBeenCalledTimes(1)
    gates[0].resolve(lease('ATRASADO'))
    await vi.advanceTimersByTimeAsync(0)
    expect(repo.releaseConversationLease).toHaveBeenCalledWith(expect.objectContaining({ token: 'ATRASADO' }))
    expect(repo.acquireConversationLease).toHaveBeenCalledTimes(2)
    gates[1].resolve(lease('NOVO'))
    await next
    expect(keepers.map((k) => k.token)).toEqual(['NOVO'])
    expect(leases.get('c1')).toBe(keepers[0])
  })

  it('soltura presa: segue no prazo sem lançar; o keeper já saiu', async () => {
    vi.useFakeTimers()
    const { gates, keepers, leases } = harness()
    const acquiring = leases.acquire('c1')
    await vi.advanceTimersByTimeAsync(0)
    gates[0].resolve(lease('A'))
    await acquiring
    keepers[0].release = vi.fn(() => new Promise<void>(() => {}))
    const releasing = leases.release('c1')
    expect(leases.has('c1')).toBe(false)
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(releasing).resolves.toBeUndefined()
  })

  it('forget só esquece o keeper que ainda é o instalado', async () => {
    const { gates, keepers, leases } = harness()
    const a = leases.acquire('c1')
    await flush()
    gates[0].resolve(lease('A'))
    await a
    const other: TestKeeper = { token: 'outro', isInstalled: () => false, release: vi.fn(async () => undefined) }
    leases.forget('c1', other)
    expect(leases.has('c1')).toBe(true)
    leases.forget('c1', keepers[0])
    expect(leases.has('c1')).toBe(false)
  })
})
