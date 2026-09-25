import { z } from 'zod'
import { Channels } from '../../shared/ipc'
import type {
  AccountUsageResult,
  AddClaudeAccountResult,
  ClaudeAccountView,
  UseAccountResult
} from '../../shared/claudeAccounts'
import type { AccountRegistry } from './registry'

/**
 * Handlers das contas Claude. O index.ts só chama `registerClaudeAccountsIpc`.
 *
 * Fronteira: todo payload passa por zod e nenhuma exceção atravessa o IPC. Nada
 * que sai daqui carrega token — as views só têm id, apelido, e-mail, plano,
 * status e a última leitura de consumo.
 */

export type AccountsIpcListener = (event: unknown, ...args: unknown[]) => unknown

export interface ClaudeAccountsIpcDeps {
  handle: (channel: string, listener: AccountsIpcListener) => void
  registry: Pick<
    AccountRegistry,
    'list' | 'add' | 'relogin' | 'rename' | 'reorder' | 'remove' | 'isConnected' | 'autoSwitchEnabled' | 'setAutoSwitch' | 'ensureLoaded'
  >
  /** Consumo de todas as contas, ou de uma (`accountId`), com cache de 60 s. */
  usage: (force: boolean, accountId?: string) => Promise<AccountUsageResult[]>
  /** Conversas da conta removida voltam à regra de conversa nova. */
  onRemoved?: (id: string) => void
  /** Troca manual na sessão aberta da conversa; `null` = conversa sem sessão. */
  useForConversation?: (convId: string, accountId: string, continueTask: boolean) => { ok: boolean; scheduled: boolean } | null
}

const accountId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const IdReq = z.strictObject({ id: accountId })
const RenameReq = z.strictObject({ id: accountId, label: z.string().max(200) })
const ReorderReq = z.strictObject({ ids: z.array(accountId).max(50) })
const UsageReq = z.strictObject({ force: z.boolean(), accountId: accountId.optional() }).optional()
const UseReq = z.strictObject({ convId: z.string().min(1).max(200), accountId, continueTask: z.boolean() })
const AutoSwitchReq = z.strictObject({ on: z.boolean().optional() })

export function registerClaudeAccountsIpc(deps: ClaudeAccountsIpcDeps): void {
  const { handle, registry } = deps

  handle(Channels.claudeAccountsList, async (): Promise<ClaudeAccountView[]> => {
    try {
      return await registry.list()
    } catch (error) {
      console.warn('[contas] listar falhou:', (error as Error).message)
      return []
    }
  })

  handle(Channels.claudeAccountsAdd, async (): Promise<AddClaudeAccountResult> => {
    try {
      return await registry.add()
    } catch (error) {
      console.warn('[contas] adicionar falhou:', (error as Error).message)
      return { ok: false, reason: 'login-failed' }
    }
  })

  handle(Channels.claudeAccountsRelogin, async (_event, payload) => {
    const parsed = IdReq.safeParse(payload)
    if (!parsed.success) return { ok: false }
    try {
      return { ok: await registry.relogin(parsed.data.id) }
    } catch {
      return { ok: false }
    }
  })

  handle(Channels.claudeAccountsRename, async (_event, payload) => {
    const parsed = RenameReq.safeParse(payload)
    if (!parsed.success) return { ok: false }
    return { ok: await registry.rename(parsed.data.id, parsed.data.label).catch(() => false) }
  })

  handle(Channels.claudeAccountsReorder, async (_event, payload) => {
    const parsed = ReorderReq.safeParse(payload)
    if (!parsed.success) return { ok: false }
    try {
      await registry.reorder(parsed.data.ids)
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  handle(Channels.claudeAccountsRemove, async (_event, payload) => {
    const parsed = IdReq.safeParse(payload)
    if (!parsed.success) return { ok: false }
    try {
      const ok = await registry.remove(parsed.data.id)
      if (ok) deps.onRemoved?.(parsed.data.id)
      return { ok }
    } catch (error) {
      console.warn('[contas] remover falhou:', (error as Error).message)
      return { ok: false }
    }
  })

  handle(Channels.claudeAccountsUseForConversation, async (_event, payload): Promise<UseAccountResult> => {
    const parsed = UseReq.safeParse(payload)
    if (!parsed.success) return { ok: false, scheduled: false }
    const { convId, accountId: id, continueTask } = parsed.data
    try {
      // Login expirado nunca é destino, nem na troca manual.
      if (!(await registry.isConnected(id))) return { ok: false, scheduled: false }
      const result = deps.useForConversation?.(convId, id, continueTask) ?? null
      return result ?? { ok: true, scheduled: false, nextStart: true }
    } catch {
      return { ok: false, scheduled: false }
    }
  })

  handle(Channels.claudeAccountsAutoSwitch, async (_event, payload): Promise<boolean> => {
    const parsed = AutoSwitchReq.safeParse(payload ?? {})
    await registry.ensureLoaded()
    if (!parsed.success || parsed.data.on === undefined) return registry.autoSwitchEnabled()
    return registry.setAutoSwitch(parsed.data.on)
  })

  handle(Channels.claudeAccountsUsage, async (_event, payload): Promise<AccountUsageResult[]> => {
    const parsed = UsageReq.safeParse(payload)
    try {
      if (!parsed.success) return await deps.usage(false)
      return await deps.usage(parsed.data?.force === true, parsed.data?.accountId)
    } catch {
      return []
    }
  })
}
