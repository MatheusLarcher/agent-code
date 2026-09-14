import { StorageError, type ConversationLease, type PersistenceRepository } from './types'

type LeaseRepository = Pick<PersistenceRepository, 'renewConversationLease' | 'releaseConversationLease'>

/** The server grants 60s of validity, so renewing every 20s leaves room for
 * failures before the lease can actually lapse. */
export const LEASE_HEARTBEAT_MS = 20_000
/** An infrastructure hiccup (connection timeout, DB restart, laptop waking up)
 * is NOT a lost lease: nobody else took the conversation, we just could not
 * reach Postgres. Retry closer together so several attempts fit inside the
 * validity window instead of killing the running turn on the first miss. */
export const LEASE_RETRY_MS = 5_000
/** How long a release waits for a renewal already on the wire. Bounded because
 * a renewal stuck on a dead connection must never hold up the quit path. */
export const LEASE_RELEASE_WAIT_MS = 1_000

export interface LeaseKeeperOptions {
  /** Fired only when the lease provably belongs to someone else — the writer
   * must stop, because its fenced writes will (and should) be rejected. */
  onLost: (error: StorageError) => void
  /** Fired on every failed attempt that is worth retrying; the keeper stays alive. */
  onTransientFailure?: (error: unknown) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Keeps one conversation lease alive for as long as its session runs.
 *
 * A renewal that fails because the row no longer matches our token is terminal
 * (another installation owns the conversation). Every other failure is treated
 * as transient and retried: the row still carries our token, so a later renewal
 * revives it — and if someone did steal it in the meantime, the next attempt
 * comes back as LEASE_HELD_BY_OTHER_DEVICE and we stop then. */
export class ConversationLeaseKeeper {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: Promise<void> | null = null
  private stopped = false
  private held: ConversationLease

  constructor(
    readonly repository: LeaseRepository,
    lease: ConversationLease,
    private readonly options: LeaseKeeperOptions
  ) {
    this.held = lease
  }

  get lease(): ConversationLease {
    return this.held
  }

  start(): this {
    this.schedule(LEASE_HEARTBEAT_MS)
    return this
  }

  /** Stops the heartbeat and hands the lease back, after giving a renewal that
   * is already on the wire a short moment to land — one committed after the
   * release would give the row another 60s of validity. The wait is bounded:
   * a revived lease only ever delays ANOTHER device (this installation
   * re-acquires its own lease no matter what), while waiting on a wedged
   * connection would stall the app's shutdown. */
  async release(): Promise<void> {
    this.stop()
    if (this.pending) {
      await Promise.race([this.pending, sleep(LEASE_RELEASE_WAIT_MS)]).catch(() => undefined)
    }
    await this.repository.releaseConversationLease(this.held).catch(() => undefined)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(delay: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.pending = this.renew().finally(() => {
        this.pending = null
      })
    }, delay)
    this.timer.unref?.()
  }

  private async renew(): Promise<void> {
    try {
      const renewed = await this.repository.renewConversationLease(this.held)
      if (this.stopped) return
      this.held = renewed
      this.schedule(LEASE_HEARTBEAT_MS)
    } catch (error) {
      if (this.stopped) return
      if (error instanceof StorageError && error.code === 'LEASE_HELD_BY_OTHER_DEVICE') {
        this.stop()
        this.options.onLost(error)
        return
      }
      this.options.onTransientFailure?.(error)
      this.schedule(LEASE_RETRY_MS)
    }
  }
}
