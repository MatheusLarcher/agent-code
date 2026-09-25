import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  AccountUsageReading,
  AddClaudeAccountResult,
  ClaudeAccountStatus,
  ClaudeAccountView
} from '../../shared/claudeAccounts'
import type { ClaudeAuthStatus } from '../auth'
import {
  accountDir,
  machineConfigDir,
  prepareAccountDir,
  readCredentialInfo,
  readOauthEmail,
  removeAccountDir
} from './accountDirs'
import type { AccountCandidate } from './selection'

/** Id fixo da conta que usa o login que já existia na máquina (~/.claude). */
export const DEFAULT_ACCOUNT_ID = 'default'

/** Chave KV da lista (escopo do dispositivo: as pastas são locais). */
export const CLAUDE_ACCOUNTS_KV_KEY = 'agentcode.claude-accounts.v1'

const windowSchema = z.object({ utilization: z.number().nullable(), resetsAt: z.number().nullable() })
const readingSchema = z.object({ at: z.number(), windows: z.record(z.string(), windowSchema) })
const recordSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  label: z.string().max(80).default(''),
  email: z.string().nullable().default(null),
  plan: z.string().nullable().default(null),
  rateLimitTier: z.string().nullable().default(null),
  usage: readingSchema.nullable().default(null)
})
const storedSchema = z.object({
  accounts: z.array(recordSchema),
  /** Interruptor "Troca automática de conta". Padrão: ligado. */
  autoSwitch: z.boolean().default(true)
})

type AccountRecord = z.infer<typeof recordSchema>

export interface RegistryDeps {
  /** Raiz local do app (`agent-code-local`), nunca a pasta sincronizada. */
  localDir: () => string
  readKv: (key: string) => Promise<string | null>
  writeKv: (key: string, value: string) => Promise<void>
  /** `claude auth status --json` para uma pasta (undefined = a da máquina). */
  authStatus: (configDir?: string) => Promise<ClaudeAuthStatus>
  /** Login OAuth pelo navegador numa pasta. */
  login: (configDir: string) => Promise<boolean>
  loginBusy: (configDir: string) => boolean
}

/**
 * A lista de contas Claude, na ordem do usuário. Guarda id, apelido, e-mail,
 * plano e a última leitura de consumo — NUNCA token: esse fica no
 * `.credentials.json` da pasta da conta.
 */
export function createAccountRegistry(deps: RegistryDeps) {
  let accounts: AccountRecord[] = []
  let autoSwitch = true
  let loaded: Promise<void> | null = null
  // Status do login da máquina quando não há `.credentials.json` para ler (ex.:
  // credencial no chaveiro do sistema). `auth status` custa ~0,8 s: cache curto.
  let defaultAuth: { at: number; status: ClaudeAuthStatus } | null = null

  function blank(id: string): AccountRecord {
    return { id, label: '', email: null, plan: null, rateLimitTier: null, usage: null }
  }

  function ensureLoaded(): Promise<void> {
    loaded ??= deps
      .readKv(CLAUDE_ACCOUNTS_KV_KEY)
      .then((raw) => {
        const parsed = raw ? storedSchema.safeParse(JSON.parse(raw)) : null
        accounts = parsed?.success ? parsed.data.accounts : []
        autoSwitch = parsed?.success ? parsed.data.autoSwitch : true
      })
      .catch((error) => {
        console.warn('[contas] lista ilegível, recomeçando só com a conta atual:', (error as Error).message)
        accounts = []
      })
      .then(() => {
        // Conta 1 = o login que já existe. Quem tem uma conta só não percebe nada.
        if (!accounts.some((account) => account.id === DEFAULT_ACCOUNT_ID)) accounts.unshift(blank(DEFAULT_ACCOUNT_ID))
      })
    return loaded
  }

  function persist(): void {
    const payload = JSON.stringify({ accounts, autoSwitch })
    void deps.writeKv(CLAUDE_ACCOUNTS_KV_KEY, payload).catch((error) => {
      console.warn('[contas] não consegui gravar a lista:', (error as Error).message)
    })
  }

  /** Pasta de config da conta; `undefined` para a conta padrão (a da máquina). */
  function configDirOf(id: string): string | undefined {
    return id === DEFAULT_ACCOUNT_ID ? undefined : accountDir(deps.localDir(), id)
  }

  async function defaultAuthStatus(): Promise<ClaudeAuthStatus> {
    if (defaultAuth && Date.now() - defaultAuth.at < 30_000) return defaultAuth.status
    const status = await deps.authStatus()
    defaultAuth = { at: Date.now(), status }
    return status
  }

  async function statusOf(record: AccountRecord): Promise<ClaudeAccountStatus> {
    const dir = configDirOf(record.id)
    if (dir) {
      const cred = readCredentialInfo(dir)
      if (!cred.present) return 'logged-out'
      return cred.live ? 'connected' : 'expired'
    }
    // Conta padrão: o arquivo de credencial pode nem existir (chaveiro).
    const cred = readCredentialInfo(machineConfigDir())
    if (cred.present) return cred.live ? 'connected' : 'expired'
    return (await defaultAuthStatus()).loggedIn ? 'connected' : 'logged-out'
  }

  function tierOf(record: AccountRecord): string | null {
    const dir = configDirOf(record.id)
    if (dir) return readCredentialInfo(dir).rateLimitTier ?? record.rateLimitTier
    return record.rateLimitTier
  }

  async function view(record: AccountRecord): Promise<ClaudeAccountView> {
    return {
      id: record.id,
      label: record.label,
      email: record.email ?? readOauthEmail(configDirOf(record.id)),
      plan: record.plan,
      rateLimitTier: tierOf(record),
      status: await statusOf(record),
      isDefault: record.id === DEFAULT_ACCOUNT_ID,
      usage: record.usage
    }
  }

  function find(id: string): AccountRecord | undefined {
    return accounts.find((account) => account.id === id)
  }

  /** Relê e-mail e plano pelo CLI (sem token) e guarda. */
  async function refreshIdentity(id: string): Promise<void> {
    const record = find(id)
    if (!record) return
    const dir = configDirOf(id)
    const status = await deps.authStatus(dir)
    if (!dir) defaultAuth = { at: Date.now(), status }
    if (!status.loggedIn) return
    const email = status.email ?? readOauthEmail(dir)
    const cred = dir ? readCredentialInfo(dir) : null
    const changed =
      record.email !== (email ?? record.email) ||
      record.plan !== (status.subscriptionType ?? record.plan) ||
      (cred?.rateLimitTier != null && record.rateLimitTier !== cred.rateLimitTier)
    if (!changed) return
    record.email = email ?? record.email
    record.plan = status.subscriptionType ?? record.plan
    if (cred?.rateLimitTier) record.rateLimitTier = cred.rateLimitTier
    persist()
  }

  return {
    ensureLoaded,

    async list(): Promise<ClaudeAccountView[]> {
      await ensureLoaded()
      // Conta padrão sem e-mail guardado (primeira vez): descobre agora.
      const defaultRecord = find(DEFAULT_ACCOUNT_ID)
      if (defaultRecord && !defaultRecord.email) await refreshIdentity(DEFAULT_ACCOUNT_ID)
      return Promise.all(accounts.map(view))
    },

    /** Candidatas à escolha de conta, na ordem do usuário. */
    async candidates(): Promise<AccountCandidate[]> {
      await ensureLoaded()
      return Promise.all(
        accounts.map(async (record) => ({ id: record.id, status: await statusOf(record), usage: record.usage }))
      )
    },

    async isConnected(id: string): Promise<boolean> {
      await ensureLoaded()
      const record = find(id)
      return record ? (await statusOf(record)) === 'connected' : false
    },

    /**
     * Env do CLI para uma conta. Conta padrão (ou desconhecida) → `undefined`:
     * a sessão herda o ambiente, exatamente como antes das contas existirem.
     * Conta extra → o ambiente com o `CLAUDE_CONFIG_DIR` herdado TROCADO pelo
     * da conta, para nada vazar para a conta errada.
     */
    envFor(id: string | undefined | null): NodeJS.ProcessEnv | undefined {
      if (!id || id === DEFAULT_ACCOUNT_ID || !find(id)) return undefined
      const dir = prepareAccountDir(accountDir(deps.localDir(), id))
      const env: NodeJS.ProcessEnv = { ...process.env }
      delete env['CLAUDE_CONFIG_DIR']
      env['CLAUDE_CONFIG_DIR'] = dir
      return env
    },

    configDirOf,

    async add(): Promise<AddClaudeAccountResult> {
      await ensureLoaded()
      const id = randomUUID().replace(/-/g, '').slice(0, 12)
      const dir = accountDir(deps.localDir(), id)
      if (deps.loginBusy(dir)) return { ok: false, reason: 'busy' }
      // Pasta NOVA, login NOVO. Nada de copiar a credencial de ~/.claude: o
      // refresh token rotaciona e a cópia morre no primeiro refresh.
      prepareAccountDir(dir)
      const discard = (): void => {
        try {
          removeAccountDir(deps.localDir(), id)
        } catch (error) {
          console.warn('[contas] não consegui apagar a pasta da conta descartada:', (error as Error).message)
        }
      }
      const ok = await deps.login(dir)
      const status = ok ? await deps.authStatus(dir) : null
      if (!ok || !status?.loggedIn) {
        discard()
        return { ok: false, reason: 'login-failed' }
      }
      const email = status.email ?? readOauthEmail(dir)
      if (email) {
        // A conta padrão pode ainda não ter e-mail guardado: descobre antes de comparar.
        if (!find(DEFAULT_ACCOUNT_ID)?.email) await refreshIdentity(DEFAULT_ACCOUNT_ID)
        const same = accounts.find((account) => account.email?.toLowerCase() === email.toLowerCase())
        if (same) {
          discard()
          return { ok: false, reason: 'duplicate', email }
        }
      }
      const record: AccountRecord = {
        ...blank(id),
        email: email ?? null,
        plan: status.subscriptionType ?? readCredentialInfo(dir).subscriptionType,
        rateLimitTier: readCredentialInfo(dir).rateLimitTier
      }
      accounts.push(record)
      persist()
      return { ok: true, account: await view(record) }
    },

    /** "Entrar de novo" numa conta existente (login expirado). */
    async relogin(id: string): Promise<boolean> {
      await ensureLoaded()
      const record = find(id)
      if (!record || id === DEFAULT_ACCOUNT_ID) return false
      const dir = prepareAccountDir(accountDir(deps.localDir(), id))
      if (deps.loginBusy(dir)) return false
      const ok = await deps.login(dir)
      if (ok) await refreshIdentity(id)
      return ok
    },

    async rename(id: string, label: string): Promise<boolean> {
      await ensureLoaded()
      const record = find(id)
      if (!record) return false
      record.label = label.trim().slice(0, 80)
      persist()
      return true
    },

    /** Nova ordem. Ids desconhecidos são ignorados; os que faltarem vão para o fim. */
    async reorder(ids: readonly string[]): Promise<void> {
      await ensureLoaded()
      const byId = new Map(accounts.map((account) => [account.id, account]))
      const next: AccountRecord[] = []
      for (const id of ids) {
        const record = byId.get(id)
        if (record && !next.includes(record)) next.push(record)
      }
      for (const record of accounts) if (!next.includes(record)) next.push(record)
      accounts = next
      persist()
    },

    /** Remove a conta e apaga a pasta dela. A conta padrão (login da máquina) não sai. */
    async remove(id: string): Promise<boolean> {
      await ensureLoaded()
      if (id === DEFAULT_ACCOUNT_ID || !find(id)) return false
      removeAccountDir(deps.localDir(), id)
      accounts = accounts.filter((account) => account.id !== id)
      persist()
      return true
    },

    loadUsage(id: string): AccountUsageReading | null {
      return find(id)?.usage ?? null
    },

    saveUsage(id: string, reading: AccountUsageReading): void {
      const record = find(id)
      if (!record) return
      record.usage = reading
      persist()
    },

    ids(): string[] {
      return accounts.map((account) => account.id)
    },

    /** Nome para mostrar: apelido, e-mail ou "Conta N" (posição na ordem). */
    labelOf(id: string): string {
      const index = accounts.findIndex((account) => account.id === id)
      const record = accounts[index]
      if (!record) return 'removida'
      return record.label || record.email || `Conta ${index + 1}`
    },

    autoSwitchEnabled(): boolean {
      return autoSwitch
    },

    async setAutoSwitch(on: boolean): Promise<boolean> {
      await ensureLoaded()
      autoSwitch = on
      persist()
      return autoSwitch
    },

    /** Há conta além do login da máquina? Sem isso, nada muda em relação a antes. */
    hasExtraAccounts(): boolean {
      return accounts.some((account) => account.id !== DEFAULT_ACCOUNT_ID)
    }
  }
}

export type AccountRegistry = ReturnType<typeof createAccountRegistry>
