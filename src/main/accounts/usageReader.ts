import type { AccountUsageReading, AccountUsageResult, UsageWindow } from '../../shared/claudeAccounts'

/** Leitura com menos de 60 s não é refeita. */
export const USAGE_CACHE_TTL_MS = 60_000
/** Teto de uma consulta; medido ~1,1–1,4 s por conta (abrir, consultar, fechar). */
export const USAGE_QUERY_TIMEOUT_MS = 5_000

export interface UsageReaderDeps {
  /** Consulta de verdade (processo do CLI da conta). Lança em falha. */
  fetchWindows: (accountId: string, signal: AbortSignal) => Promise<Record<string, UsageWindow>>
  /** Última leitura guardada da conta. */
  load: (accountId: string) => AccountUsageReading | null
  /** Grava a leitura nova. */
  save: (accountId: string, reading: AccountUsageReading) => void
  now?: () => number
  ttlMs?: number
  timeoutMs?: number
}

/**
 * Lê o consumo das contas sob demanda — sem polling. Cache de 60 s por conta,
 * uma consulta por conta de cada vez (quem pede junto espera a mesma), várias
 * contas em paralelo. Falha ou timeout devolve a última leitura guardada
 * (`fresh: false`); quem decide trata janela vencida como zerada.
 */
export function createUsageReader(deps: UsageReaderDeps) {
  const now = deps.now ?? Date.now
  const ttl = deps.ttlMs ?? USAGE_CACHE_TTL_MS
  const timeout = deps.timeoutMs ?? USAGE_QUERY_TIMEOUT_MS
  const inFlight = new Map<string, Promise<AccountUsageResult>>()

  async function fetchFresh(accountId: string): Promise<AccountUsageResult> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const windows = await Promise.race([
        deps.fetchWindows(accountId, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error('timeout'))
          }, timeout)
        })
      ])
      const reading: AccountUsageReading = { at: now(), windows }
      deps.save(accountId, reading)
      return { accountId, reading, fresh: true }
    } catch (error) {
      console.warn(`[contas] consumo da conta ${accountId} indisponível: ${(error as Error)?.message ?? error}`)
      return { accountId, reading: deps.load(accountId), fresh: false }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function read(accountId: string, options: { force?: boolean } = {}): Promise<AccountUsageResult> {
    const cached = deps.load(accountId)
    if (!options.force && cached && now() - cached.at < ttl) {
      return Promise.resolve({ accountId, reading: cached, fresh: true })
    }
    const pending = inFlight.get(accountId)
    if (pending) return pending
    const request = fetchFresh(accountId).finally(() => inFlight.delete(accountId))
    inFlight.set(accountId, request)
    return request
  }

  function readMany(accountIds: readonly string[], options: { force?: boolean } = {}): Promise<AccountUsageResult[]> {
    return Promise.all(accountIds.map((id) => read(id, options)))
  }

  return { read, readMany }
}

export type UsageReader = ReturnType<typeof createUsageReader>
