import { Client, type ClientConfig } from 'pg'
import { applySessionTimeouts } from './postgresSessionSetup'
import type { RepositoryChange, RepositoryChangeHandler } from './types'

interface ChangeRow {
  change_id: string
  entity: RepositoryChange['entity']
  entity_id: string
  revision: string | number | null
  installation_id: string | null
}

/** Espera antes de cada nova tentativa de reabrir o LISTEN depois de uma queda.
 *  A conexão LISTEN fica ociosa por horas, então é ela que sente primeiro o PC
 *  voltar da suspensão (socket morto) ou a rede piscar. Isso NÃO é o banco fora:
 *  o pool de dados abre conexões novas sozinho. Só depois de esgotar estas
 *  tentativas (~15s sem conseguir falar com o servidor) o backend é declarado
 *  offline — antes, uma queda de um segundo trocava a tela inteira do app por
 *  "Persistência indisponível" e derrubava as sessões dos agentes. */
export const FEED_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const

export class PostgresChangeFeed {
  private client: Client | null = null
  private cursor = 0
  private draining: Promise<void> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  /** Tentativas seguidas de reconexão que falharam desde a última queda. */
  private failures = 0
  private offlineReported = false

  constructor(
    private readonly config: ClientConfig,
    private readonly installationId: string,
    private readonly onChanges: RepositoryChangeHandler,
    private readonly onOffline: (error: unknown) => void
  ) {}

  async start(): Promise<void> {
    this.closed = false
    // Na abertura, quem decide o que fazer com a falha é o chamador (o
    // repositório ainda é candidato); não há o que reconectar.
    await this.connect(true)
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

  private async connect(initial = false): Promise<void> {
    if (this.closed) return
    const client = new Client(this.config)
    client.on('notification', () => this.scheduleDrain())
    client.on('error', () => {
      // Erro de um cliente que ainda não assumiu (conexão/LISTEN em curso) já
      // rejeita a promessa abaixo; tratar aqui também contaria a falha duas vezes.
      if (this.client !== client) return
      this.connectionLost(client)
    })
    try {
      await client.connect()
      // Tetos do servidor por SET, não no startup (PgBouncer): postgresSessionSetup.ts.
      await applySessionTimeouts(client)
      await client.query('LISTEN agent_code_changes')
      const saved = await client.query<{ change_id: string | number }>(
        'SELECT change_id FROM installation_change_cursors WHERE installation_id = $1',
        [this.installationId]
      )
      // Nunca volta o cursor: o salvo pode estar atrás do que já foi entregue.
      this.cursor = Math.max(this.cursor, Number(saved.rows[0]?.change_id ?? 0))
      if (this.closed) {
        await client.end().catch(() => undefined)
        return
      }
      this.client = client
      this.failures = 0
      this.offlineReported = false
      // O que mudou enquanto o LISTEN estava fora é recuperado aqui, pelo cursor.
      await this.drain()
    } catch (error) {
      if (this.client === client) this.client = null
      await client.end().catch(() => undefined)
      if (initial) throw error
      this.failures += 1
      if (this.failures >= FEED_RECONNECT_DELAYS_MS.length && !this.offlineReported && !this.closed) {
        this.offlineReported = true
        this.onOffline(error)
      }
      this.scheduleReconnect()
    }
  }

  /** O socket do LISTEN morreu (ou uma leitura nele falhou): descarta o cliente
   *  e reabre em segundo plano. O backend continua de pé durante a tentativa. */
  private connectionLost(client: Client): void {
    if (this.client === client) this.client = null
    void client.end().catch(() => undefined)
    this.scheduleReconnect()
  }

  private scheduleDrain(): void {
    if (this.draining || this.closed) return
    const client = this.client
    this.draining = this.drain()
      .catch(() => {
        if (!this.closed && client) this.connectionLost(client)
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
    const delay = FEED_RECONNECT_DELAYS_MS[Math.min(this.failures, FEED_RECONNECT_DELAYS_MS.length - 1)]
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect()
    }, delay)
    this.retryTimer.unref?.()
  }
}
