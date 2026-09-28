import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { accountsRoot, globalConfigFile, readOauthEmail } from './accountDirs'

/**
 * O que a lista de contas guarda e o que fica só nesta máquina: o formato do
 * registro, a leitura tolerante da lista gravada, a identidade de uma conta
 * (e-mail + organização) e a lista LOCAL de ids removidos.
 */

const windowSchema = z.object({ utilization: z.number().nullable(), resetsAt: z.number().nullable() })
const readingSchema = z.object({ at: z.number(), windows: z.record(z.string(), windowSchema) })
export const recordSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  label: z.string().max(80).default(''),
  email: z.string().nullable().default(null),
  /** `oauthAccount.organizationUuid`: separa a conta pessoal da de equipe no mesmo e-mail. */
  org: z.string().nullable().default(null),
  plan: z.string().nullable().default(null),
  rateLimitTier: z.string().nullable().default(null),
  usage: readingSchema.nullable().default(null)
})
export type AccountRecord = z.infer<typeof recordSchema>

export function blankRecord(id: string): AccountRecord {
  return { id, label: '', email: null, org: null, plan: null, rateLimitTier: null, usage: null }
}

/**
 * Lê a lista gravada conta a conta: um registro inválido fica de fora sozinho,
 * em vez de derrubar a lista inteira (e apagar as outras na próxima gravação).
 */
export function parseStored(raw: string | null): { accounts: AccountRecord[]; autoSwitch: boolean } {
  let data: unknown = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    console.warn('[contas] lista gravada ilegível; recomeçando com a conta atual')
  }
  const shape = data && typeof data === 'object' ? (data as { accounts?: unknown; autoSwitch?: unknown }) : {}
  const accounts: AccountRecord[] = []
  for (const item of Array.isArray(shape.accounts) ? shape.accounts : []) {
    const parsed = recordSchema.safeParse(item)
    if (parsed.success && !accounts.some((account) => account.id === parsed.data.id)) accounts.push(parsed.data)
    else if (!parsed.success) console.warn('[contas] registro de conta inválido ignorado')
  }
  return { accounts, autoSwitch: typeof shape.autoSwitch === 'boolean' ? shape.autoSwitch : true }
}

/** `oauthAccount.organizationUuid` do `.claude.json` de uma pasta de config (sem token). */
export function readOauthOrg(configDir: string | undefined): string | null {
  try {
    const data = JSON.parse(readFileSync(globalConfigFile(configDir), 'utf8')) as { oauthAccount?: { organizationUuid?: unknown } }
    const org = data?.oauthAccount?.organizationUuid
    return typeof org === 'string' && org ? org : null
  } catch {
    return null
  }
}

/** Quem é a conta: e-mail (minúsculo) e organização, cada um o guardado ou o da pasta. */
export interface AccountIdentity {
  email: string | null
  org: string | null
}

export function identityOf(record: AccountRecord, configDir: string | undefined): AccountIdentity {
  return {
    email: (record.email ?? readOauthEmail(configDir))?.toLowerCase() ?? null,
    org: record.org ?? readOauthOrg(configDir)
  }
}

/**
 * Mesma conta? Mesmo e-mail e, quando os DOIS lados conhecem a organização, a
 * mesma organização. A conta pessoal e a de equipe no mesmo e-mail são duas.
 * Organização desconhecida num dos lados: vale só o e-mail (não arrisca duplicar).
 */
export function sameAccount(a: AccountIdentity, b: AccountIdentity): boolean {
  if (!a.email || !b.email || a.email !== b.email.toLowerCase()) return false
  return !a.org || !b.org || a.org === b.org
}

/**
 * Grava a lista no banco com nova tentativa: se o banco recusar, tenta de novo
 * em `retryMs` com o payload DAQUELE momento (`payload()` é relido). `dispose()`
 * (fechamento do app) cancela a tentativa agendada e faz as próximas gravações
 * virarem nada: nenhum timer dispara contra a persistência já fechada.
 */
export function createListWriter(write: (value: string) => Promise<void>, retryMs: number) {
  let retry: ReturnType<typeof setTimeout> | null = null
  let closed = false
  function save(payload: () => string): void {
    if (closed) return
    if (retry) clearTimeout(retry)
    retry = null
    void write(payload()).catch((error) => {
      if (closed) return
      console.warn('[contas] não consegui gravar a lista; nova tentativa agendada:', (error as Error).message)
      if (retry) return
      retry = setTimeout(() => {
        retry = null
        save(payload)
      }, retryMs)
      retry.unref?.()
    })
  }
  return {
    save,
    /** Há nova tentativa agendada? */
    pending: (): boolean => retry !== null,
    dispose(): void {
      closed = true
      if (retry) clearTimeout(retry)
      retry = null
    }
  }
}

/** Teto da lista local de removidas: ids são aleatórios, a lista só cresce devagar. */
const REMOVED_MAX = 500

function removedFile(localDir: string): string {
  // Começa com ponto: não é nome de conta (`isSafeAccountId`), o sync não confunde com pasta.
  return join(accountsRoot(localDir), '.removed-accounts.json')
}

/**
 * Ids que o usuário removeu NESTA máquina. Ficam no disco, fora do banco: se a
 * remoção não chegou ao banco (fora do ar, app fechado antes da nova tentativa),
 * esta lista vence a do banco na próxima leitura, e o sync não restaura a conta.
 */
export function readRemovedIds(localDir: string): Set<string> {
  try {
    const data = JSON.parse(readFileSync(removedFile(localDir), 'utf8')) as unknown
    return new Set(Array.isArray(data) ? data.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

export function addRemovedId(localDir: string, id: string): void {
  const ids = [...readRemovedIds(localDir)].filter((known) => known !== id)
  ids.push(id)
  const path = removedFile(localDir)
  mkdirSync(accountsRoot(localDir), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, JSON.stringify(ids.slice(-REMOVED_MAX)), 'utf8')
  renameSync(temporary, path)
}
