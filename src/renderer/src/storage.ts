import { currentModelId } from '@shared/ipc'
import { DEFAULT_TITLE, type Conversation, type UIMessage } from './types'
import type {
  RateLimitStatus,
  RepositoryChange,
  StorageStatusDto,
  VersionedConversationDto
} from '@shared/ipc'
import { ipcStorageErrorCode } from './ipcError'

// Persistence for the conversation history + UI state. Conversations are backed
// by one SQLite db PER PROJECT (main process, via window.api.loadAllConversations/
// saveAllConversations — see src/main/projectStore.ts), not a single shared blob
// and not localStorage. UI state and usage-limits stay in the shared cache-folder
// kv store (window.api.kvGet/kvSet). The agent's own transcript is also stored by
// the SDK under ~/.claude/projects (used for `resume`); this keeps the rendered
// history + sidebar metadata across restarts.
//
// Migration: the one-time split of the old single-blob conversations list into
// per-project dbs happens transparently in the main process (projectStore.ts).
// For UI/usage-limits keys, the first time a key is missing from SQLite, any
// value still in the old localStorage is copied over (kept as a harmless backup).

const UI_KEY = 'agentcode.ui.v1'
const USAGE_LIMITS_KEY = 'agentcode.usage-limits.v1'

export interface UiState {
  collapsed: boolean
  activeId: string | null
  /** Whether the embedded browser panel is minimized. */
  browserMinimized: boolean
  /** Width (CSS px) of the browser panel, set by dragging the splitter. */
  browserWidth: number
  /** Which subscriptions the topbar usage badge shows in its compact form. */
  usageProviders: { claude: boolean; gpt: boolean }
  /** Várias contas Claude: "mostrar na barra" por conta (id → marcado). Conta
   *  ausente conta como marcada. */
  usageAccounts?: Record<string, boolean>
}

const DEFAULT_BROWSER_WIDTH = 720
const COMPACTION_AGE_MS = 15 * 24 * 60 * 60 * 1000

/** Keep only the useful narrative of conversations older than 15 days. This
 * touches Agent Code's rendered history, never the Claude SDK session files. */
export function compactOldConversations(list: Conversation[], now = Date.now()): Conversation[] {
  return list.map((conversation) => {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : []
    if (Number.isFinite(conversation.createdAt) && now - conversation.createdAt < COMPACTION_AGE_MS) {
      return messages === conversation.messages ? conversation : { ...conversation, messages }
    }
    const compacted = messages.filter(
      (message: UIMessage) => message.kind === 'user' || (message.kind === 'assistant-text' && message.answer)
    )
    return compacted.length === messages.length && messages === conversation.messages
      ? conversation
      : { ...conversation, messages: compacted }
  })
}

/** Read a key from SQLite, falling back to (and migrating from) old localStorage. */
async function readMigrating(key: string): Promise<string | null> {
  let raw: string | null = null
  try {
    raw = await window.api.kvGet(key)
  } catch {
    raw = null
  }
  if (raw != null) return raw
  // Not in SQLite yet — migrate from the legacy localStorage value, once.
  let legacy: string | null = null
  try {
    legacy = localStorage.getItem(key)
  } catch {
    legacy = null
  }
  if (legacy != null) {
    try {
      await window.api.kvSet(key, legacy)
    } catch {
      /* best-effort */
    }
  }
  return legacy
}

/** Set once the legacy localStorage blob (below) has been checked a single time,
 *  so an empty result on some LATER load (the user deleted every conversation on
 *  purpose) never gets reinterpreted as "never checked" and resurrects it again. */
const LEGACY_CHECKED_KEY = 'agentcode.conversations.legacy-checked.v1'

/**
 * Very old installs kept conversations only in the browser's own localStorage,
 * before the SQLite/per-project store existed at all — the main process has no
 * way to see or migrate that on its own. Read directly from localStorage (NEVER
 * via `window.api.kvGet`, which would return the old, already-migrated SQLite
 * blob — that one is kept only as an inert backup and must stay unread, or a
 * genuinely-emptied history would resurrect deleted conversations). Checked at
 * most once per install — see `LEGACY_CHECKED_KEY`.
 */
function readLegacyLocalStorageConversations(): Conversation[] | null {
  try {
    if (localStorage.getItem(LEGACY_CHECKED_KEY)) return null
    localStorage.setItem(LEGACY_CHECKED_KEY, '1')
    const raw = localStorage.getItem('agentcode.conversations.v1')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Conversation[]) : null
  } catch {
    return null
  }
}

const conversationRecords = new Map<string, VersionedConversationDto>()
const conversationQueues = new Map<string, Promise<void>>()
const dirtyConversationIds = new Set<string>()
const conversationGenerations = new Map<string, number>()

function cleanConversation(conversation: Conversation): Conversation {
  return JSON.parse(
    JSON.stringify(compactOldConversations([conversation])[0], (key, value) =>
      key === 'images' ? undefined : value
    )
  ) as Conversation
}

/**
 * Serialização ESTÁVEL: chaves de objeto em ordem alfabética, recursivamente.
 *
 * Existe por causa do PostgreSQL. O payload é uma coluna `jsonb`, e JSONB não
 * guarda a ordem das chaves — ele devolve na ordem interna dele (comprimento,
 * depois bytes), inclusive nos objetos aninhados. Com `JSON.stringify` cru, a
 * comparação "isso mudou?" do autosave NUNCA dava igual contra o que voltou do
 * banco, e cada tick reescrevia todas as conversas carregadas: no servidor
 * deste usuário isso virou 200 mil updates numa tabela de 52 linhas. Sob
 * SQLite o texto voltava na ordem original e o problema não aparecia.
 *
 * Arrays mantêm a ordem — nelas a ordem é dado, não formatação.
 */
function serialized(value: unknown): string {
  return JSON.stringify(stable(value))
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) out[key] = stable(source[key])
  return out
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function timestamp(value: unknown, recordValue: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Date.parse(recordValue)
  return Number.isFinite(parsed) ? parsed : 0
}

/** PostgreSQL is authoritative storage, but its JSONB payloads may have been
 * written by an older Agent Code build or recovered from a partial legacy
 * record. Normalize the renderer's required fields at this boundary so one
 * malformed conversation cannot make the entire history unavailable. */
function normalizeConversation(record: VersionedConversationDto): Conversation {
  const payload = record.payload
  const rawTokens = payload.tokens && typeof payload.tokens === 'object'
    ? payload.tokens as Record<string, unknown>
    : {}
  const todoPlan = payload.todoPlan && typeof payload.todoPlan === 'object'
    ? payload.todoPlan as Record<string, unknown>
    : null
  return {
    ...payload,
    id: record.id,
    title: typeof payload.title === 'string' && payload.title.trim() ? payload.title : DEFAULT_TITLE,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
    // Modelo aposentado (ex.: GPT-5.6) vira o substituto — senão a conversa
    // perderia o provedor e iria para a Anthropic com um id que ela não conhece.
    model: typeof payload.model === 'string' && payload.model ? currentModelId(payload.model) : 'claude-opus-5-5',
    sdkSessionId: typeof payload.sdkSessionId === 'string' ? payload.sdkSessionId : null,
    claudeAccountId:
      typeof payload.claudeAccountId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(payload.claudeAccountId)
        ? payload.claudeAccountId
        : undefined,
    messages: Array.isArray(payload.messages) ? payload.messages as UIMessage[] : [],
    tokens: {
      context: finiteNumber(rawTokens.context),
      output: finiteNumber(rawTokens.output),
      cost: finiteNumber(rawTokens.cost)
    },
    createdAt: timestamp(payload.createdAt, record.createdAt),
    updatedAt: timestamp(payload.updatedAt, record.updatedAt),
    todoPlan: todoPlan && Array.isArray(todoPlan.items)
      ? payload.todoPlan as Conversation['todoPlan']
      : undefined
  }
}

/** How many conversations of EACH project the app loads when it opens. The
 *  sidebar shows this many per project and a "mostrar mais" fetches the rest. */
export const CONVERSATIONS_PER_PROJECT = 6

/** Quantos projetos entram na PRIMEIRA leitura de conversas. O resto vem em
 *  segundo plano, projeto a projeto, depois que a tela já está montada — com o
 *  banco autoritativo remoto, uma leitura só com todos os projetos é dezenas de
 *  MB de payload na frente da primeira pintura. */
export const PROJECTS_IN_FIRST_PAGE = 4

/** Tamanho de cada lote de projetos carregado em segundo plano. */
export const PROJECTS_PER_BACKGROUND_BATCH = 4

/** Um projeto como o banco o conhece, SEM payload nenhum: é o que deixa a barra
 *  lateral aparecer inteira (nome + total) antes de qualquer conversa chegar. */
export interface ProjectSummary {
  cwd: string
  total: number
  /** Epoch ms da conversa mais recente do projeto — a ordem da barra lateral. */
  updatedAt: number
}

/** Normalize authoritative records into renderer conversations, remembering each
 *  record's revision so later CAS writes and change-feed merges have a baseline.
 *  Tombstones are remembered but never returned. */
function absorbRecords(records: VersionedConversationDto[]): Conversation[] {
  const list: Conversation[] = []
  for (const record of records) {
    const normalized = normalizeConversation(record)
    conversationRecords.set(record.id, {
      ...record,
      payload: normalized as unknown as Record<string, unknown>
    })
    if (!record.deletedAt) list.push(normalized)
  }
  return list
}

/** Initial load. With `perProject`, only the N most recent conversations of each
 *  project come down; with `cwds`, only those projects. The rest stays in the
 *  database until `loadProjectsPage`/`loadProjectConversations` asks for it.
 *  Saving is per-record (upsert/delete by id), so a partially loaded list is
 *  safe: records that were never loaded are never touched. */
export async function loadConversations(options?: {
  perProject?: number
  cwds?: string[]
}): Promise<Conversation[]> {
  const query: { perProject?: number; cwds?: string[] } = {}
  if (options?.perProject) query.perProject = options.perProject
  if (options?.cwds) query.cwds = options.cwds
  const records = await window.api.loadVersionedConversations(
    Object.keys(query).length ? query : undefined
  )
  conversationRecords.clear()
  const list = absorbRecords(records)
  if (list.length) return compactOldConversations(list)
  // Only a genuinely successful empty authoritative read may consult the one-time
  // browser-local migration source. Storage errors deliberately propagate.
  const legacy = readLegacyLocalStorageConversations()
  return legacy ? compactOldConversations(legacy) : []
}

/** A primeira página de mais alguns projetos, SEM zerar o que já está carregado —
 *  é o que o carregamento em segundo plano usa, lote a lote. */
export async function loadProjectsPage(cwds: string[], perProject: number): Promise<Conversation[]> {
  if (!cwds.length) return []
  const records = await window.api.loadVersionedConversations({ cwds, perProject })
  return compactOldConversations(absorbRecords(records))
}

/** Conversas específicas por id (a conversa ativa da sessão anterior, por
 *  exemplo), sem zerar o que já está carregado. */
export async function loadConversationsByIds(ids: string[]): Promise<Conversation[]> {
  if (!ids.length) return []
  const records = await window.api.loadVersionedConversations({ ids })
  return compactOldConversations(absorbRecords(records))
}

/** Every live conversation of one project ("mostrar mais"). Records already held
 *  locally are refreshed only in the revision map; the caller decides which
 *  conversation object wins on screen (the local one may carry unsaved state). */
export async function loadProjectConversations(cwd: string): Promise<Conversation[]> {
  const records = await window.api.loadVersionedConversations({ cwd })
  return compactOldConversations(absorbRecords(records))
}

/**
 * Espera a persistência autoritativa sair de `booting`.
 *
 * A janela abre ANTES de o banco estar pronto (ver `app.whenReady()` em
 * src/main/index.ts): com um PostgreSQL remoto, conectar e migrar leva segundos,
 * e prender a interface nisso era o que fazia o app "não abrir". Sem esta espera
 * a primeira leitura do renderer chegaria com o backend ainda subindo e voltaria
 * STORAGE_OFFLINE — uma tela de erro para uma condição passageira.
 */
export function waitForStorageReady(): Promise<StorageStatusDto> {
  return new Promise((resolve) => {
    let off: (() => void) | null = null
    let settled = false
    const finish = (status: StorageStatusDto): void => {
      if (settled) return
      settled = true
      off?.()
      resolve(status)
    }
    off = window.api.onStorageStatusChanged((status) => {
      if (status.state !== 'booting') finish(status)
    })
    if (settled) return
    // Corrida: o backend pode ter ficado pronto antes de assinarmos.
    void window.api
      .getStorageStatus()
      .then((status) => {
        if (status.state !== 'booting') finish(status)
      })
      .catch(() => undefined)
  })
}

/**
 * Os projetos do banco (pasta + total + data da conversa mais recente), do mais
 * recente para o mais antigo. É uma agregação — não traz payload de conversa
 * nenhuma —, então a barra lateral pode aparecer completa enquanto as conversas
 * ainda estão vindo. Projeto sem pasta (`cwd` vazio) fica de fora: a barra
 * lateral não tem onde mostrá-lo.
 */
export async function loadProjectSummaries(): Promise<ProjectSummary[]> {
  const rows = await window.api.countConversationsByProject()
  return rows
    .filter((row) => row.cwd)
    .map((row) => ({
      cwd: row.cwd,
      total: row.total,
      updatedAt: Number.isFinite(Date.parse(row.updatedAt)) ? Date.parse(row.updatedAt) : 0
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

function enqueueConversation(id: string, write: () => Promise<VersionedConversationDto>): Promise<void> {
  const generation = (conversationGenerations.get(id) ?? 0) + 1
  conversationGenerations.set(id, generation)
  dirtyConversationIds.add(id)
  const previous = conversationQueues.get(id) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(async () => {
    const stored = await write()
    conversationRecords.set(id, stored)
    if (conversationGenerations.get(id) === generation) dirtyConversationIds.delete(id)
  })
  conversationQueues.set(id, next)
  void next.finally(() => {
    if (conversationQueues.get(id) === next) conversationQueues.delete(id)
  }).catch(() => undefined)
  return next
}

/** Re-read the authoritative revision of one conversation. Used to rebase a
 * compare-and-set that lost the race, so a single stale revision cannot wedge
 * every later write of that conversation. */
async function authoritativeRevision(id: string): Promise<number | undefined> {
  const records = await window.api.loadVersionedConversations({ ids: [id], includeDeleted: true })
  const record = records.find((entry) => entry.id === id)
  if (record) conversationRecords.set(id, record)
  else conversationRecords.delete(id)
  return record?.revision
}

/**
 * Run a compare-and-set write, rebasing ONCE if the stored revision moved.
 * The local state is what the user is looking at, so a lost race means our
 * cached revision is stale — not that the edit should be dropped. Without this
 * the mismatch is permanent: `conversationRecords` never catches up and every
 * following write of that conversation fails with the same conflict.
 */
async function writeWithRebase(
  id: string,
  attempt: (expectedRevision: number | undefined) => Promise<VersionedConversationDto>
): Promise<VersionedConversationDto> {
  try {
    return await attempt(conversationRecords.get(id)?.revision)
  } catch (error) {
    if (ipcStorageErrorCode(error) !== 'REVISION_CONFLICT') throw error
    return attempt(await authoritativeRevision(id))
  }
}

export async function saveConversations(list: Conversation[]): Promise<void> {
  const clean = list.map(cleanConversation)
  const nextIds = new Set(clean.map((conversation) => conversation.id))
  const writes: Promise<void>[] = []
  for (const conversation of clean) {
    const current = conversationRecords.get(conversation.id)
    if (!current?.deletedAt && serialized(current?.payload) === serialized(conversation)) continue
    writes.push(
      enqueueConversation(conversation.id, () =>
        writeWithRebase(conversation.id, (expectedRevision) =>
          window.api.upsertConversation({
            id: conversation.id,
            payload: conversation as unknown as Record<string, unknown>,
            ...(expectedRevision === undefined ? {} : { expectedRevision })
          })
        )
      )
    )
  }
  for (const current of conversationRecords.values()) {
    if (current.deletedAt || nextIds.has(current.id)) continue
    writes.push(
      enqueueConversation(current.id, () =>
        writeWithRebase(current.id, (expectedRevision) =>
          // A conversation that already vanished upstream needs no tombstone.
          expectedRevision === undefined
            ? Promise.resolve(conversationRecords.get(current.id) ?? current)
            : window.api.deleteConversation({ id: current.id, expectedRevision })
        )
      )
    )
  }
  await Promise.all(writes)
}

/** This installation's id, used to ignore the change feed's echo of our OWN
 * writes. Read lazily (and cached) so no caller has to thread it through. */
let localInstallationId: string | null = null
async function installationId(): Promise<string | null> {
  if (localInstallationId) return localInstallationId
  try {
    localInstallationId = (await window.api.getStorageStatus()).installationId
  } catch {
    /* keep null — the revision guard below still applies */
  }
  return localInstallationId
}

/** Mark conversations as locally-modified BEFORE the debounced write runs.
 * Without this there is a window (the debounce) in which the local state already
 * has new messages but nothing is dirty yet, so a change-feed notification would
 * replace the conversation with the last persisted revision and the message
 * would vanish from the screen a moment after being typed. */
export function markConversationsDirty(ids: Iterable<string>): void {
  for (const id of ids) dirtyConversationIds.add(id)
}

/** Reload only the authoritative records signaled by the durable change feed.
 * Dirty local conversations are intentionally omitted so drafts or rejected
 * writes cannot be overwritten by another installation. Changes this
 * installation produced are skipped entirely: they can only carry data we just
 * wrote, never anything newer than what is already on screen. */
export async function loadConversationChanges(changes: RepositoryChange[]): Promise<Map<string, Conversation | null>> {
  const self = await installationId()
  const ids = new Set(
    changes
      .filter((change) => change.entity === 'conversation')
      .filter((change) => !self || change.installationId !== self)
      .map((change) => change.entityId)
  )
  if (!ids.size) return new Map()
  const records = await window.api.loadVersionedConversations({ ids: [...ids], includeDeleted: true })
  const fetched = new Map(records.map((record) => [record.id, record]))
  const result = new Map<string, Conversation | null>()
  for (const id of ids) {
    if (dirtyConversationIds.has(id)) continue
    const record = fetched.get(id)
    // A revision we already hold carries the same payload — applying it would
    // only risk clobbering newer local state with identical stored state.
    const known = conversationRecords.get(id)
    if (record && known && record.revision <= known.revision) continue
    const normalized = record ? normalizeConversation(record) : null
    if (record && normalized) {
      conversationRecords.set(id, {
        ...record,
        payload: normalized as unknown as Record<string, unknown>
      })
    }
    if (!record || record.deletedAt) result.set(id, null)
    else result.set(id, normalized)
  }
  return result
}

export async function loadUi(): Promise<UiState> {
  const fallback: UiState = {
    collapsed: false,
    activeId: null,
    browserMinimized: false,
    browserWidth: DEFAULT_BROWSER_WIDTH,
    usageProviders: { claude: true, gpt: true }
  }
  try {
    const raw = await readMigrating(UI_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiState>
      return {
        ...fallback,
        ...parsed,
        usageProviders: { ...fallback.usageProviders, ...(parsed.usageProviders ?? {}) }
      }
    }
  } catch {
    /* ignore */
  }
  return fallback
}

export async function saveUi(ui: UiState): Promise<void> {
  await window.api.kvSet(UI_KEY, JSON.stringify(ui))
}

/** Load the last known account-wide rate-limit snapshot (5h / weekly / etc.).
 *  Falls back to legacy localStorage once, like the other UI/conversation keys. */
export async function loadUsageLimits(): Promise<Record<string, RateLimitStatus>> {
  try {
    const raw = await readMigrating(USAGE_LIMITS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, RateLimitStatus>) : {}
  } catch {
    return {}
  }
}

/** Persist the account-wide rate-limit snapshot so the badge is visible on
 *  app launch even before the next agent turn. */
export async function saveUsageLimits(limits: Record<string, RateLimitStatus>): Promise<void> {
  try {
    await window.api.kvSet(USAGE_LIMITS_KEY, JSON.stringify(limits))
  } catch {
    /* store error — usage badge is best-effort */
  }
}
