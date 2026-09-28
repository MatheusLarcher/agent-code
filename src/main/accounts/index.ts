import { safeStorage } from 'electron'
import type { AccountUsageResult } from '../../shared/claudeAccounts'
import { claudeAuthStatus } from '../auth'
import { claudeLoginBusyFor, runClaudeLogin } from '../login'
import { readPersistedKv, writePersistedKv } from '../persistence/kvFacade'
import { getCacheInfo } from '../store'
import { forgetAccountBackup, syncClaudeAccounts, type AccountSyncDeps } from './accountSync'
import { createAccountRegistry, DEFAULT_ACCOUNT_ID } from './registry'
import { accountForConversation } from './selection'
import { createSessionSwitchDeps } from './sessionSwitch'
import type { AccountSwitchDeps } from './switchDeps'
import { exhaustedReading, mergeReading, windowFromRateLimitEvent } from './usageMath'
import { fetchAccountWindows } from './usageQuery'
import { createUsageReader } from './usageReader'

export { DEFAULT_ACCOUNT_ID } from './registry'

/** Quem abre a URL de login e onde vai o diagnóstico; ligado no boot (index.ts). */
let loginIo: { openUrl: (url: string) => void; log: (line: string) => void } = {
  openUrl: () => undefined,
  log: () => undefined
}

export function configureAccountLogin(io: typeof loginIo): void {
  loginIo = io
}

export const claudeAccounts = createAccountRegistry({
  localDir: () => getCacheInfo().localDir,
  readKv: readPersistedKv,
  writeKv: writePersistedKv,
  authStatus: claudeAuthStatus,
  login: (configDir) => runClaudeLogin(loginIo.openUrl, loginIo.log, configDir),
  loginBusy: claudeLoginBusyFor,
  onLogin: () => void syncAccountsWithDatabase(),
  onRemove: (id) => {
    void forgetAccountBackup(syncDeps, id).catch((error) => {
      console.warn('[contas] não consegui tirar do banco a cópia da conta removida:', (error as Error).message)
    })
  }
})

/** `safeStorage` lido na hora do uso: módulos de teste mocam o electron sem ele. */
const syncDeps: AccountSyncDeps = {
  localDir: () => getCacheInfo().localDir,
  readKv: readPersistedKv,
  writeKv: writePersistedKv,
  cipher: {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain) => safeStorage.encryptString(plain),
    decryptString: (encrypted) => safeStorage.decryptString(encrypted),
    // Só existe no Linux; sem chaveiro dá 'basic_text' e nada de credencial é gravado.
    storageBackend: () => (process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os')
  },
  registry: claudeAccounts
}

let accountSyncTimer: ReturnType<typeof setInterval> | null = null
let accountSyncStopped = false

/**
 * Lista de contas × pastas × cópia no banco (ver accountSync.ts). Nunca lança:
 * falhar aqui só adia para a próxima passada.
 */
export async function syncAccountsWithDatabase(): Promise<void> {
  if (accountSyncStopped) return
  try {
    await syncClaudeAccounts(syncDeps)
  } catch (error) {
    console.warn('[contas] conferência das contas falhou:', (error as Error).message)
  }
}

/** A cada 10 min: o CLI renova o token dentro da pasta, e a cópia acompanha. */
export function startAccountSync(): void {
  void syncAccountsWithDatabase()
  if (accountSyncTimer) clearInterval(accountSyncTimer)
  accountSyncTimer = setInterval(() => void syncAccountsWithDatabase(), 10 * 60_000)
  accountSyncTimer.unref()
}

/**
 * Fechamento do app (antes de fechar a persistência): para o relógio do sync e
 * a nova tentativa de gravar a lista de contas — nada dispara contra o banco fechado.
 */
export function stopAccountSync(): void {
  accountSyncStopped = true
  if (accountSyncTimer) clearInterval(accountSyncTimer)
  accountSyncTimer = null
  claudeAccounts.dispose()
}

const usageReader = createUsageReader({
  fetchWindows: (accountId, signal) => fetchAccountWindows(claudeAccounts.envFor(accountId), signal),
  load: (accountId) => claudeAccounts.loadUsage(accountId),
  save: (accountId, reading) => claudeAccounts.saveUsage(accountId, reading)
})

/**
 * Consumo de uma conta, consultado DE VERDADE (sem mandar mensagem), com cache
 * de 60 s e queda para a última leitura em falha/timeout (5 s).
 */
export async function queryAccountUsage(accountId: string, options: { force?: boolean } = {}): Promise<AccountUsageResult> {
  await claudeAccounts.ensureLoaded()
  return usageReader.read(accountId, options)
}

/** Várias contas em paralelo (painel de consumo, hora da troca). */
export async function queryAllAccountsUsage(options: { force?: boolean } = {}): Promise<AccountUsageResult[]> {
  await claudeAccounts.ensureLoaded()
  return usageReader.readMany(claudeAccounts.ids(), options)
}

/** Conta de cada conversa com sessão aberta neste processo (convId → conta). */
const conversationAccounts = new Map<string, string>()

/**
 * Conta de uma sessão que está subindo: a gravada com a conversa, se ainda
 * estiver conectada; senão a regra de conversa nova (pela última leitura, sem
 * consultar — não atrasa o primeiro envio). `undefined` = login da máquina.
 */
export async function resolveSessionAccount(
  convId: string,
  stored: string | undefined,
  model: string | undefined
): Promise<string> {
  await claudeAccounts.ensureLoaded()
  // Uma conta só: nada a escolher — nem status a calcular. Igual a antes.
  const chosen = !claudeAccounts.hasExtraAccounts()
    ? DEFAULT_ACCOUNT_ID
    : (accountForConversation(stored, await claudeAccounts.candidates(), model) ?? DEFAULT_ACCOUNT_ID)
  conversationAccounts.set(convId, chosen)
  return chosen
}

/**
 * As dependências da troca automática de conta de uma conversa (ver
 * providerFailover.ts). `acquire` pega o lease da conversa antes de uma troca
 * com o turno fechado.
 */
export function accountSwitchDepsFor(convId: string, acquire: () => Promise<void>): AccountSwitchDeps {
  return createSessionSwitchDeps({
    candidates: () => claudeAccounts.candidates(),
    readUsage: (ids, force) => usageReader.readMany(ids, { force }),
    multiple: () => claudeAccounts.hasExtraAccounts(),
    autoEnabled: () => claudeAccounts.autoSwitchEnabled(),
    label: (id) => claudeAccounts.labelOf(id),
    // Os observadores seguem a conta da conversa: trocam junto.
    changed: (id) => conversationAccounts.set(convId, id),
    acquire,
    markExhausted: (id, text) => claudeAccounts.saveUsage(id, exhaustedReading(claudeAccounts.loadUsage(id), text, Date.now()))
  })
}

export function conversationAccount(convId: string): string | undefined {
  return conversationAccounts.get(convId)
}

export function forgetConversationAccount(convId: string): void {
  conversationAccounts.delete(convId)
}

/**
 * Env dos observadores (Vigia, Memorista, PO, título): a MESMA conta da conversa
 * que acompanham — o gasto fica junto da conversa. Sem conversa de origem, a
 * conta que a regra de conversa nova escolheria. `undefined` = login da máquina.
 */
export async function observerEnvFor(convId: string | undefined, model?: string): Promise<NodeJS.ProcessEnv | undefined> {
  await claudeAccounts.ensureLoaded()
  if (!claudeAccounts.hasExtraAccounts()) return undefined
  const known = convId ? conversationAccounts.get(convId) : undefined
  const id = known ?? accountForConversation(undefined, await claudeAccounts.candidates(), model)
  return claudeAccounts.envFor(id)
}

/**
 * A leitura que chega pela sessão ativa (`rate_limit_event` e `refreshUsage`)
 * atualiza a última leitura DA CONTA daquela sessão.
 */
export function recordSessionRateLimit(
  convId: string,
  limits: { rateLimitType?: string; utilization?: number; resetsAt?: number; status?: string }
): void {
  const accountId = conversationAccounts.get(convId)
  if (!accountId || limits.rateLimitType?.startsWith('gpt_')) return
  const entry = windowFromRateLimitEvent(limits)
  if (!entry) return
  const merged = mergeReading(claudeAccounts.loadUsage(accountId), { [entry.key]: entry.window }, Date.now())
  claudeAccounts.saveUsage(accountId, merged)
}
