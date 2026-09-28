import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import type { Queryable } from './postgresAppendDeadline'
import { hashJson, normalizeJson } from './hashes'

/**
 * COMMIT AMBÍGUO no append do espelho: o COMMIT saiu, mas a resposta não voltou
 * (conexão caiu, "Query read timeout"). O servidor pode ter gravado ou não. O
 * SDK repete toda rejeição que não é o timeout dele (sendWithRetry), e as
 * entradas sem uuid (título, tag, marcador de modo, agent_metadata) não têm
 * ON CONFLICT — repetir às cegas as gravaria em dobro. Deduplicar por conteúdo
 * não serve: entradas idênticas legítimas existem.
 *
 * A resposta é exata: o id da transação (`txid_current()`, obtido dentro dela)
 * fica guardado com o hash do lote, e a próxima chamada da mesma
 * sessão/subpath pergunta ao servidor `txid_status(txid)` antes de gravar:
 * - 'committed' + mesmo lote → já gravado, sucesso sem gravar de novo;
 * - 'committed' com outro lote, ou 'aborted' → grava normalmente;
 * - 'in progress', NULL ou banco fora → não dá para saber: rejeita como
 *   transitório (PendingCommitUnresolvedError) e mantém a pendência.
 *
 * `txid_current`/`txid_status` (e não `pg_current_xact_id`/`pg_xact_status`):
 * o projeto não declara versão mínima do PostgreSQL, e as txid_* existem do 10
 * ao 18; as pg_xact_* só do 13 em diante.
 *
 * O registro é por banco, não por Pool (ver `pendingCommitsFor`): a reconexão
 * troca o Pool e a pendência precisa atravessá-la.
 *
 * Uma pendência por sessão/subpath (a nova substitui a antiga), expirando em
 * PENDING_COMMIT_TTL_MS: depois disso o `txid_status` pode nem responder mais,
 * e o SDK já desistiu daquele lote há muito.
 */

export const PENDING_COMMIT_TTL_MS = 5 * 60_000

export interface PendingCommit {
  txid: string
  batchHash: string
  /** Contador de ocorrências do modo replay calculado na tentativa ambígua;
   *  vale se ela gravou. */
  seen?: Map<string, number>
  expiresAt: number
}

export class PendingCommitUnresolvedError extends Error {
  constructor(
    readonly txid: string,
    readonly status: string | null
  ) {
    super(`COMMIT anterior do espelho (txid ${txid}) ainda sem desfecho: txid_status = ${status ?? 'NULL'}`)
    this.name = 'PendingCommitUnresolvedError'
  }
}

/** Hash do lote: entradas E ordem. */
export function batchHash(entries: SessionStoreEntry[]): string {
  return hashJson(normalizeJson(entries))
}

export type PendingResolution = { alreadyWritten: true; seen?: Map<string, number> } | { alreadyWritten: false }

export class PendingCommits {
  private readonly items = new Map<string, PendingCommit>()

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.items.size
  }

  record(key: string, pending: Omit<PendingCommit, 'expiresAt'>): void {
    this.sweep()
    this.items.set(key, { ...pending, expiresAt: this.now() + PENDING_COMMIT_TTL_MS })
  }

  get(key: string): PendingCommit | undefined {
    const pending = this.items.get(key)
    if (pending && pending.expiresAt <= this.now()) {
      this.items.delete(key)
      console.warn(`[session-store] pendência de COMMIT ambíguo expirou sem desfecho (txid ${pending.txid})`)
      return undefined
    }
    return pending
  }

  /**
   * Resolve a pendência da chave ANTES de gravar. Erro da consulta (banco
   * fora) sobe como veio e a pendência fica; desfecho desconhecido vira
   * PendingCommitUnresolvedError, também mantendo a pendência.
   */
  async resolve(db: Queryable, key: string, hash: string): Promise<PendingResolution> {
    const pending = this.get(key)
    if (!pending) return { alreadyWritten: false }
    const result = await db.query<{ status: string | null }>('SELECT txid_status($1::bigint) AS status', [pending.txid])
    const status = result.rows[0]?.status ?? null
    if (status === 'committed') {
      this.items.delete(key)
      return pending.batchHash === hash ? { alreadyWritten: true, seen: pending.seen } : { alreadyWritten: false }
    }
    if (status === 'aborted') {
      this.items.delete(key)
      return { alreadyWritten: false }
    }
    throw new PendingCommitUnresolvedError(pending.txid, status)
  }

  private sweep(): void {
    const at = this.now()
    for (const [key, pending] of this.items) if (pending.expiresAt <= at) this.items.delete(key)
  }
}

/**
 * Registro por BANCO, não por objeto Pool. A queda que deixa o COMMIT ambíguo é
 * a mesma que faz a reconexão automática fechar o pool (setOffline → pool.end())
 * e instalar outro: presa ao Pool, a pendência sumia exatamente quando era
 * preciso, e a repetição do SDK regravava as entradas sem uuid. O txid vale no
 * cluster inteiro, então a identidade é o alvo da conexão (host, porta, banco,
 * usuário) — um banco diferente não herda a pendência de outro.
 */
const registries = new Map<string, PendingCommits>()

interface PoolTarget {
  options?: { host?: unknown; port?: unknown; database?: unknown; user?: unknown; connectionString?: unknown }
}

export function databaseIdentity(pool: object): string {
  const options = (pool as PoolTarget).options ?? {}
  if (typeof options.connectionString === 'string') {
    try {
      const url = new URL(options.connectionString)
      return `${url.hostname}:${url.port || '5432'}/${decodeURIComponent(url.pathname.slice(1))}@${decodeURIComponent(url.username)}`
    } catch {
      // Sem formato de URL: a string sem a senha não dá para separar; o texto
      // inteiro serve de chave (nunca sai do processo).
      return options.connectionString
    }
  }
  const text = (value: unknown, fallback: string): string =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : fallback
  return `${text(options.host, 'localhost')}:${text(options.port, '5432')}/${text(options.database, '')}@${text(options.user, '')}`
}

/** Pendências do banco deste pool: sobrevivem a stores e pools recriados (a
 *  chave da pendência inclui conversa, modo e sessão/subpath). */
export function pendingCommitsFor(pool: object): PendingCommits {
  const identity = databaseIdentity(pool)
  let registry = registries.get(identity)
  if (!registry) {
    registry = new PendingCommits()
    registries.set(identity, registry)
  }
  return registry
}
