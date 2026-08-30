import { Client, type ClientConfig } from 'pg'
import type { RepositoryChange, RepositoryChangeHandler } from './types'

interface ChangeRow {
  change_id: string
  entity: RepositoryChange['entity']
  entity_id: string
  revision: string | number | null
  installation_id: string | null
}

export class PostgresChangeFeed {
  private client: Client | null = null
  private cursor = 0
  private draining: Promise<void> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(
    private readonly config: ClientConfig,
    private readonly installationId: string,
    private readonly onChanges: RepositoryChangeHandler,
    private readonly onOffline: (error: unknown) => void
  ) {}

  async start(): Promise<void> {
    this.closed = false
    await this.connect()
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    await this.draining?.catch(() => undefined)
    const client = this.client
    this.client = null
    await client?.end().catch(() => undefined)
  }

  private async connect(): Promise<void> {
    if (this.closed) return
    const client = new Client(this.config)
    client.on('notification', () => this.scheduleDrain())
    client.on('error', (error) => {
      if (this.client === client) this.client = null
      this.onOffline(error)
      this.scheduleReconnect()
    })
    try {
      await client.connect()
      await client.query('LISTEN agent_code_changes')
      const saved = await client.query<{ change_id: string | number }>(
        'SELECT change_id FROM installation_change_cursors WHERE installation_id = $1',
        [this.installationId]
      )
      this.cursor = Number(saved.rows[0]?.change_id ?? 0)
      this.client = client
      await this.drain()
    } catch (error) {
      await client.end().catch(() => undefined)
      this.onOffline(error)
      this.scheduleReconnect()
      throw error
    }
  }

  private scheduleDrain(): void {
    if (this.draining || this.closed) return
    this.draining = this.drain()
      .catch((error) => {
        if (!this.closed) {
          this.onOffline(error)
          this.scheduleReconnect()
        }
      })
      .finally(() => {
        this.draining = null
      })
  }

  private async drain(): Promise<void> {
    const client = this.client
    if (!client || this.closed) return
    while (!this.closed) {
      const result = await client.query<ChangeRow>(
        `SELECT change_id, entity, entity_id, revision, installation_id
         FROM change_log
         WHERE change_id > $1
           AND (scope <> 'device' OR installation_id = $2)
         ORDER BY change_id LIMIT 500`,
        [this.cursor, this.installationId]
      )
      if (!result.rowCount) return
      const latestByEntity = new Map<string, RepositoryChange>()
      for (const row of result.rows) {
        const change: RepositoryChange = {
          changeId: String(row.change_id),
          entity: row.entity,
          entityId: row.entity_id,
          ...(row.revision === null ? {} : { revision: Number(row.revision) }),
          ...(row.installation_id ? { installationId: row.installation_id } : {})
        }
        latestByEntity.set(`${change.entity}:${change.entityId}`, change)
        this.cursor = Math.max(this.cursor, Number(row.change_id))
      }
      this.onChanges([...latestByEntity.values()])
      await client.query(
        `INSERT INTO installation_change_cursors(installation_id, change_id)
         VALUES($1, $2)
         ON CONFLICT(installation_id) DO UPDATE SET
           change_id = GREATEST(installation_change_cursors.change_id, EXCLUDED.change_id),
           updated_at = clock_timestamp()`,
        [this.installationId, this.cursor]
      )
      if (result.rowCount < 500) return
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect().catch(() => undefined)
    }, 1_000)
    this.retryTimer.unref?.()
  }
}
