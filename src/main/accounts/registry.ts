import { randomUUID } from 'node:crypto'
import type {
  AccountUsageReading,
  AddClaudeAccountResult,
  ClaudeAccountStatus,
  ClaudeAccountView
} from '../../shared/claudeAccounts'
import type { ClaudeAuthStatus } from '../auth'
import {
  accountDir,
  clearRecreatedMark,
  machineConfigDir,
  prepareAccountDir,
  readCredentialInfo,
  readOauthEmail,
  removeAccountDir
} from './accountDirs'
import {
  addRemovedId,
  blankRecord,
  createListWriter,
  identityOf,
  parseStored,
  readOauthOrg,
  readRemovedIds,
  sameAccount,
  type AccountIdentity,
  type AccountRecord
} from './registryStore'
import type { AccountCandidate } from './selection'

/** Id fixo da conta que usa o login que já existia na máquina (~/.claude). */
export const DEFAULT_ACCOUNT_ID = 'default'

/** Chave KV da lista (escopo do dispositivo: as pastas são locais). */
export const CLAUDE_ACCOUNTS_KV_KEY = 'agentcode.claude-accounts.v1'

/** Nova tentativa de gravar a lista quando o banco recusou (padrão: 30 s). */
const PERSIST_RETRY_MS = 30_000

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
  /** Login novo numa pasta de conta: hora de copiar a credencial para o banco. */
  onLogin?: (id: string) => void
  /** Conta removida pelo usuário: a cópia dela no banco também sai. */
  onRemove?: (id: string) => void
  /** Intervalo da nova tentativa de gravar a lista (testes). */
  persistRetryMs?: number
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

  const blank = blankRecord

  function withDefault(): void {
    // Conta 1 = o login que já existe. Quem tem uma conta só não percebe nada.
    if (!accounts.some((account) => account.id === DEFAULT_ACCOUNT_ID)) accounts.unshift(blank(DEFAULT_ACCOUNT_ID))
  }

  /** O banco já respondeu? Só então a lista em memória pode ir para ele. */
  let fromStore = false
  /** Ids com login em andamento (add/relogin): o sync não adota nem mexe na pasta. */
  const reserved = new Set<string>()
  /**
   * Ajustes feitos antes de a lista ser lida do banco. Ficam guardados e são
   * aplicados POR CIMA do que vier do banco — antes, o IPC respondia sucesso e
   * a leitura seguinte trazia o valor antigo de volta.
   */
  const early: { autoSwitch: boolean | null; labels: Map<string, string>; order: readonly string[] | null } = {
    autoSwitch: null,
    labels: new Map(),
    order: null
  }

  /** Já há na lista a mesma conta (e-mail + organização, ver `sameAccount`)? */
  function hasAccount(identity: AccountIdentity): boolean {
    return accounts.some((account) => sameAccount(identityOf(account, configDirOf(account.id)), identity))
  }

  function applyOrder(ids: readonly string[]): void {
    const byId = new Map(accounts.map((account) => [account.id, account]))
    const next: AccountRecord[] = []
    for (const id of ids) {
      const record = byId.get(id)
      if (record && !next.includes(record)) next.push(record)
    }
    for (const record of accounts) if (!next.includes(record)) next.push(record)
    accounts = next
  }

  /** Aplica os ajustes guardados antes da leitura. true = algo mudou. */
  function applyEarly(): boolean {
    let changed = false
    if (early.autoSwitch !== null) {
      changed ||= autoSwitch !== early.autoSwitch
      autoSwitch = early.autoSwitch
    }
    for (const [id, label] of early.labels) {
      const record = find(id)
      if (record && record.label !== label) {
        record.label = label
        changed = true
      }
    }
    if (early.order) {
      const before = accounts.map((account) => account.id).join()
      applyOrder(early.order)
      changed ||= before !== accounts.map((account) => account.id).join()
    }
    early.autoSwitch = null
    early.labels.clear()
    early.order = null
    return changed
  }

  /**
   * Lê a lista do banco. Se o banco ainda não respondeu (a janela sobe antes
   * dele), fica com a conta padrão SÓ em memória e tenta de novo na próxima
   * chamada — antes, a falha ficava guardada para sempre e a próxima gravação
   * apagava do banco as outras contas (a "2ª conta esquecida").
   */
  function ensureLoaded(): Promise<void> {
    loaded ??= deps.readKv(CLAUDE_ACCOUNTS_KV_KEY).then(
      (raw) => {
        const pending = fromStore ? [] : accounts.filter((account) => account.id !== DEFAULT_ACCOUNT_ID)
        const stored = parseStored(raw)
        // Removida aqui e a remoção não chegou ao banco: a lista local vence.
        const removed = readRemovedIds(deps.localDir())
        accounts = stored.accounts.filter((account) => account.id === DEFAULT_ACCOUNT_ID || !removed.has(account.id))
        const dropped = stored.accounts.length - accounts.length
        autoSwitch = stored.autoSwitch
        withDefault()
        // Conta adicionada enquanto o banco não respondia: não se perde, mas
        // também não duplica uma que o banco já tem (mesmo e-mail e organização).
        let merged = 0
        for (const record of pending) {
          if (find(record.id)) continue
          const identity = identityOf(record, configDirOf(record.id))
          if (identity.email && hasAccount(identity)) {
            console.warn('[contas] conta adicionada com o banco fora já estava na lista (mesma conta); a pasta fica no disco')
            continue
          }
          accounts.push(record)
          merged++
        }
        fromStore = true
        if (applyEarly() || merged || dropped) persist()
      },
      (error) => {
        console.warn('[contas] banco ainda indisponível; a lista será lida de novo:', (error as Error).message)
        loaded = null
        withDefault()
      }
    )
    return loaded
  }

  const writer = createListWriter((value) => deps.writeKv(CLAUDE_ACCOUNTS_KV_KEY, value), deps.persistRetryMs ?? PERSIST_RETRY_MS)

  /**
   * Grava a lista. Se o banco recusar (fora do ar), tenta de novo mais tarde com
   * a lista DAQUELE momento — uma remoção feita com o banco fora chega a ele
   * quando ele volta. Se o app fechar antes, a lista local de removidas cobre.
   */
  function persist(): void {
    if (!fromStore) {
      console.warn('[contas] lista não gravada: o banco ainda não foi lido')
      return
    }
    writer.save(() => JSON.stringify({ accounts, autoSwitch }))
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
    const org = readOauthOrg(dir)
    const cred = dir ? readCredentialInfo(dir) : null
    const changed =
      record.email !== (email ?? record.email) ||
      record.org !== (org ?? record.org) ||
      record.plan !== (status.subscriptionType ?? record.plan) ||
      (cred?.rateLimitTier != null && record.rateLimitTier !== cred.rateLimitTier)
    if (!changed) return
    record.email = email ?? record.email
    record.org = org ?? record.org
    record.plan = status.subscriptionType ?? record.plan
    if (cred?.rateLimitTier) record.rateLimitTier = cred.rateLimitTier
    persist()
  }

  /** O add() depois de reservar o id: login, dedup por e-mail + organização e gravação. */
  async function addInto(id: string, dir: string): Promise<AddClaudeAccountResult> {
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
    clearRecreatedMark(dir) // login feito: um logout daqui em diante é logout
    const email = status.email ?? readOauthEmail(dir)
    const org = readOauthOrg(dir)
    if (email) {
      // A conta padrão pode ainda não ter e-mail guardado: descobre antes de comparar.
      if (!find(DEFAULT_ACCOUNT_ID)?.email) await refreshIdentity(DEFAULT_ACCOUNT_ID)
      // Mesmo e-mail em outra organização (pessoal × equipe) é outra conta.
      if (hasAccount({ email: email.toLowerCase(), org })) {
        discard()
        return { ok: false, reason: 'duplicate', email }
      }
    }
    const record: AccountRecord = {
      ...blank(id),
      email: email ?? null,
      org,
      plan: status.subscriptionType ?? readCredentialInfo(dir).subscriptionType,
      rateLimitTier: readCredentialInfo(dir).rateLimitTier
    }
    accounts.push(record)
    persist()
    deps.onLogin?.(id)
    return { ok: true, account: await view(record) }
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
      // A pasta é deste add() até ele terminar: o sync não a adota no meio.
      reserved.add(id)
      try {
        return await addInto(id, dir)
      } finally {
        reserved.delete(id)
      }
    },

    /** "Entrar de novo" numa conta existente (login expirado). */
    async relogin(id: string): Promise<boolean> {
      await ensureLoaded()
      const record = find(id)
      if (!record || id === DEFAULT_ACCOUNT_ID) return false
      const dir = prepareAccountDir(accountDir(deps.localDir(), id))
      if (deps.loginBusy(dir)) return false
      reserved.add(id)
      let ok = false
      try {
        ok = await deps.login(dir)
        if (ok) clearRecreatedMark(dir)
        if (ok) await refreshIdentity(id)
      } finally {
        reserved.delete(id)
      }
      if (ok) deps.onLogin?.(id)
      return ok
    },

    /** Login em andamento nesta conta (add/relogin)? O sync deixa a pasta em paz. */
    busy(id: string): boolean {
      return reserved.has(id)
    },

    /**
     * Põe na lista uma conta que existe só na pasta (a lista a tinha perdido).
     * Recusa id repetido, id com login em andamento, id removido nesta máquina,
     * conta (e-mail + organização) que já está na lista e pasta sem e-mail (sem
     * ele não há como saber se é a mesma conta de outra pasta): nunca duplica.
     */
    async adopt(
      id: string,
      info: { email: string | null; org?: string | null; plan: string | null; rateLimitTier: string | null }
    ): Promise<boolean> {
      await ensureLoaded()
      if (!fromStore || id === DEFAULT_ACCOUNT_ID || find(id) || reserved.has(id)) return false
      if (readRemovedIds(deps.localDir()).has(id)) return false
      const org = info.org ?? null
      if (!info.email || hasAccount({ email: info.email.toLowerCase(), org })) return false
      accounts.push({ ...blank(id), email: info.email, org, plan: info.plan, rateLimitTier: info.rateLimitTier })
      persist()
      return true
    },

    /** A lista já foi lida do banco (e pode ser gravada nele)? */
    storeReady(): boolean {
      return fromStore
    },

    async rename(id: string, label: string): Promise<boolean> {
      await ensureLoaded()
      const record = find(id)
      if (!record) return false
      record.label = label.trim().slice(0, 80)
      // Banco ainda não lido: vale quando ele for lido (por cima do valor antigo).
      if (!fromStore) early.labels.set(id, record.label)
      persist()
      return true
    },

    /** Nova ordem. Ids desconhecidos são ignorados; os que faltarem vão para o fim. */
    async reorder(ids: readonly string[]): Promise<void> {
      await ensureLoaded()
      applyOrder(ids)
      if (!fromStore) early.order = [...ids]
      persist()
    },

    /**
     * Remove a conta e apaga a pasta dela. A conta padrão (login da máquina) não
     * sai. O id vai ANTES para a lista local de removidas: se o banco estiver fora,
     * a gravação tenta de novo, e até lá (mesmo com o app reaberto) a conta não
     * volta da lista do banco nem é restaurada pelo sync.
     */
    async remove(id: string): Promise<boolean> {
      await ensureLoaded()
      if (id === DEFAULT_ACCOUNT_ID || !find(id)) return false
      addRemovedId(deps.localDir(), id)
      removeAccountDir(deps.localDir(), id)
      accounts = accounts.filter((account) => account.id !== id)
      persist()
      deps.onRemove?.(id)
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
      // Banco ainda não lido: o interruptor vale quando ele for lido, por cima do gravado.
      if (!fromStore) early.autoSwitch = on
      persist()
      return autoSwitch
    },

    /** Há conta além do login da máquina? Sem isso, nada muda em relação a antes. */
    hasExtraAccounts(): boolean {
      return accounts.some((account) => account.id !== DEFAULT_ACCOUNT_ID)
    },

    /** Fechamento do app: cancela a nova tentativa agendada; nada mais é gravado. */
    dispose(): void {
      writer.dispose()
    },

    /** Há nova tentativa de gravar a lista agendada? */
    retryPending: (): boolean => writer.pending()
  }
}

export type AccountRegistry = ReturnType<typeof createAccountRegistry>
