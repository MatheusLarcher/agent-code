// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ConversationLeaseKeeper,
  LEASE_HEARTBEAT_MS,
  LEASE_RELEASE_WAIT_MS,
  LEASE_RETRY_MS
} from './leaseKeeper'
import { StorageError, type ConversationLease } from './types'

const lease: ConversationLease = {
  conversationId: 'conv-1',
  ownerInstallationId: 'inst-1',
  token: 'token-1',
  fencingEpoch: 1,
  expiresAt: '2026-01-01T00:00:00.000Z'
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ConversationLeaseKeeper', () => {
  it('retries a connection failure instead of giving the lease up', async () => {
    vi.useFakeTimers()
    const renewConversationLease = vi.fn()
      .mockRejectedValueOnce(new Error('Connection terminated due to connection timeout'))
      .mockResolvedValue({ ...lease, expiresAt: '2026-01-01T00:01:00.000Z' })
    const releaseConversationLease = vi.fn(async () => {})
    const onLost = vi.fn()
    const onTransientFailure = vi.fn()
    const keeper = new ConversationLeaseKeeper(
      { renewConversationLease, releaseConversationLease },
      lease,
      { onLost, onTransientFailure }
    ).start()

    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_MS)
    expect(renewConversationLease).toHaveBeenCalledTimes(1)
    expect(onTransientFailure).toHaveBeenCalledTimes(1)
    expect(onLost).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(LEASE_RETRY_MS)
    expect(renewConversationLease).toHaveBeenCalledTimes(2)
    expect(keeper.lease.expiresAt).toBe('2026-01-01T00:01:00.000Z')
    expect(onLost).not.toHaveBeenCalled()

    // Back on the normal cadence once the renewal succeeds.
    await vi.advanceTimersByTimeAsync(LEASE_RETRY_MS)
    expect(renewConversationLease).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_MS - LEASE_RETRY_MS)
    expect(renewConversationLease).toHaveBeenCalledTimes(3)

    keeper.stop()
  })

  it('gives up only when the lease belongs to another installation', async () => {
    vi.useFakeTimers()
    const denied = new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'O lease não pertence mais a esta instalação.')
    const renewConversationLease = vi.fn().mockRejectedValue(denied)
    const releaseConversationLease = vi.fn(async () => {})
    const onLost = vi.fn()
    new ConversationLeaseKeeper(
      { renewConversationLease, releaseConversationLease },
      lease,
      { onLost }
    ).start()

    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_MS)
    expect(onLost).toHaveBeenCalledWith(denied)

    await vi.advanceTimersByTimeAsync(10 * LEASE_HEARTBEAT_MS)
    expect(renewConversationLease).toHaveBeenCalledTimes(1)
    expect(onLost).toHaveBeenCalledTimes(1)
  })

  it('releases only after the renewal in flight settles', async () => {
    vi.useFakeTimers()
    let settle: () => void = () => undefined
    const renewConversationLease = vi.fn(
      () => new Promise<ConversationLease>((resolve) => { settle = (): void => resolve(lease) })
    )
    const releaseConversationLease = vi.fn(async () => {})
    const keeper = new ConversationLeaseKeeper(
      { renewConversationLease, releaseConversationLease },
      lease,
      { onLost: vi.fn() }
    ).start()

    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_MS)
    expect(renewConversationLease).toHaveBeenCalledTimes(1)

    const releasing = keeper.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(releaseConversationLease).not.toHaveBeenCalled()

    settle()
    await releasing
    expect(releaseConversationLease).toHaveBeenCalledWith(lease)
    // A renewal that lands after the release must not schedule another beat.
    await vi.advanceTimersByTimeAsync(10 * LEASE_HEARTBEAT_MS)
    expect(renewConversationLease).toHaveBeenCalledTimes(1)
  })

  it('does not let a wedged renewal hold up the release', async () => {
    vi.useFakeTimers()
    const renewConversationLease = vi.fn(() => new Promise<ConversationLease>(() => {}))
    const releaseConversationLease = vi.fn(async () => {})
    const keeper = new ConversationLeaseKeeper(
      { renewConversationLease, releaseConversationLease },
      lease,
      { onLost: vi.fn() }
    ).start()

    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_MS)
    const releasing = keeper.release()
    await vi.advanceTimersByTimeAsync(LEASE_RELEASE_WAIT_MS)
    await releasing
    expect(releaseConversationLease).toHaveBeenCalledWith(lease)
  })
})
