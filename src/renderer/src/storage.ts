import { currentModelId } from '@shared/ipc'
import { migrateConversationEffort } from '@shared/autoEffort'
import { compactConversation } from '@shared/conversationCompaction'
import { DEFAULT_TITLE, type Conversation, type UIMessage } from './types'
import { normalizeCentralState } from './central/centralRegistry'
import { createCentralStorage } from './central/centralMergeStorage'
import { normalizeTurnInFlight } from './turnInFlight'
import type {
  RateLimitStatus,
  RepositoryChange,
  StorageStatusDto,
  VersionedConversationDto
} from '@shared/ipc'
import { forgetConversation, isConversationDirty, markConversationsLoaded } from './conversationSync'
import { BULK_READ_DEADLINE_MS } from '@shared/readDeadline'

/** As cargas de volume (abertura, lotes de projetos, "mostrar mais") têm prazo maior que o das leituras comuns. */
const BULK = { deadlineMs: BULK_READ_DEADLINE_MS }

export { markConversationsDirty } from './conversationSync'

// Persistence for the conversation history + UI state. Conversations are READ
// here (window.api.loadVersionedConversations) and WRITTEN by the main process's
// write queue: the screen hands it only what changed and never waits for the
// database (conversationSync.ts → src/main/persistence/writeQueue/). UI state and
// usage-limits stay in the kv store (window.api.kvGet/kvSet). The agent's own
// transcript is also stored by the SDK under ~/.claude/projects (used for
// `resume`); this keeps the rendered history + sidebar metadata across restarts.
//
// For UI/usage-limits keys, the first time a key is missing from the store, any
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

/** Keep only the useful narrative of conversations older than 15 days. This
 * touches Agent Code's rendered history, never the Claude SDK session files. */
export function compactOldConversations(list: Conversation[], now = Date.now()): Conversation[] {
  return list.map((conversation) => compactConversation(conversation, now))
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
    return Array.isArray(parsed) ? (parsed as Conversation[]).map((c) => migrateConversationEffort(c)) : null
  } catch {
    return null
  }
}

/** A maior revisão vista de cada conversa (leituras e feed): um aviso do feed que
 *  não passa dela traz o que a tela já tem. Gravar é com a fila do main, que guarda
 *  a sua própria base do compare-and-set. */
const knownRevisions = new Map<string, number>()

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
  // Registro anterior à separação dos Automáticos → effort:'auto'. One-shot pelo
  // marcador (ver migrateConversationEffort), que vai na próxima escrita dele.
  const payload = migrateConversationEffort(record.payload)
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
      : undefined,
    // A Central (ver central/): entrada torta sai aqui, antes de chegar à tela.
    ...(payload.central !== undefined ? { central: normalizeCentralState(payload.central) } : {}),
    // Turno em voo (turnInFlight.ts): marca torta não vira retomada no boot.
    ...(payload.turnInFlight !== undefined ? { turnInFlight: normalizeTurnInFlight(payload.turnInFlight) } : {})
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

function rememberRevision(record: VersionedConversationDto): void {
  knownRevisions.set(record.id, Math.max(knownRevisions.get(record.id) ?? 0, record.revision))
}

/** Normalize authoritative records into renderer conversations (compacted),
 *  remembering each record's revision for the change feed and marking each object
 *  as "came from the database", so it is never handed back to the write queue
 *  unless the screen changes it. Tombstones are remembered but never returned. */
function absorbRecords(records: VersionedConversationDto[]): Conversation[] {
  const list: Conversation[] = []
  for (const record of records) {
    rememberRevision(record)
    if (!record.deletedAt) list.push(normalizeConversation(record))
  }
  const compacted = compactOldConversations(list)
  markConversationsLoaded(compacted)
  return compacted
}

/** Initial load. With `perProject`, only the N most recent conversations of each
 *  project come down; with `cwds`, only those projects. The rest stays in the
 *  database until `loadProjectsPage`/`loadProjectConversations` asks for it.
 *  Writing is per-record, by what changed on screen, so a partially loaded list
 *  is safe: records that were never loaded are never touched. */
export async function loadConversations(options?: {
  perProject?: number
  cwds?: string[]
}): Promise<Conversation[]> {
  const query: { perProject?: number; cwds?: string[] } = {}
  if (options?.perProject) query.perProject = options.perProject
  if (options?.cwds) query.cwds = options.cwds
  const records = await window.api.loadVersionedConversations(
    Object.keys(query).length ? query : undefined,
    BULK
  )
  knownRevisions.clear()
  const list = absorbRecords(records)
  if (list.length) return list
  // Only a genuinely successful empty authoritative read may consult the one-time
  // browser-local migration source. Storage errors deliberately propagate. These
  // are NOT marked as loaded: the first autosave tick hands them to the queue.
  const legacy = readLegacyLocalStorageConversations()
  return legacy ? compactOldConversations(legacy) : []
}

/** A primeira página de mais alguns projetos, SEM zerar o que já está carregado —
 *  é o que o carregamento em segundo plano usa, lote a lote. */
export async function loadProjectsPage(cwds: string[], perProject: number): Promise<Conversation[]> {
  if (!cwds.length) return []
  return absorbRecords(await window.api.loadVersionedConversations({ cwds, perProject }, BULK))
}

/** Conversas específicas por id (a conversa ativa da sessão anterior, por
 *  exemplo), sem zerar o que já está carregado. */
export async function loadConversationsByIds(ids: string[]): Promise<Conversation[]> {
  if (!ids.length) return []
  return absorbRecords(await window.api.loadVersionedConversations({ ids }))
}

/** Every live conversation of one project ("mostrar mais"). The caller decides
 *  which conversation object wins on screen (the local one may carry state the
 *  write queue has not stored yet). */
export async function loadProjectConversations(cwd: string): Promise<Conversation[]> {
  return absorbRecords(await window.api.loadVersionedConversations({ cwd }, BULK))
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

/* A Central é UMA linha que os dois PCs gravam. A gravação (mesclada por dono, com
 * rebase no conflito) é da fila do main; aqui a tela recebe o remoto mesclado —
 * pelo feed e quando a fila relê a Central num conflito (ver
 * central/centralMergeStorage.ts). */
const central = createCentralStorage({
  knownRevision: (id) => knownRevisions.get(id),
  normalize: normalizeConversation
})
/** O App registra quem põe a Central mesclada na tela; `null` desliga. */
export const registerCentralUpdater = central.register

/** A fila do main releu a Central num conflito de revisão: a tela mescla por dono
 *  o que veio do outro PC (o main já gravou a mescla). */
export async function mergeCentralRemote(record: VersionedConversationDto): Promise<void> {
  central.mergeRemote(record, await installationId())
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

/** Reload only the authoritative records signaled by the durable change feed.
 * Conversations changed on screen and not yet handed to the write queue are
 * intentionally omitted (the main process already holds back the feed of the
 * ones waiting in its queue, and its reads show them on top of the database), so
 * another installation never overwrites them. Changes this installation produced
 * are skipped entirely: they can only carry data we just wrote, never anything
 * newer than what is already on screen. */
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
    if (central.handles(id)) {
      central.mergeChange(fetched.get(id), self) // suja ou não: mescla por dono
      continue
    }
    if (isConversationDirty(id)) continue
    const record = fetched.get(id)
    // A revision we already hold carries the same payload — applying it would
    // only risk clobbering newer local state with identical stored state.
    const known = knownRevisions.get(id)
    if (record && known !== undefined && record.revision <= known) continue
    if (record) rememberRevision(record)
    if (!record || record.deletedAt) {
      // Apagada noutro PC: sai da tela sem virar uma exclusão daqui.
      forgetConversation(id)
      result.set(id, null)
      continue
    }
    const conversation = normalizeConversation(record)
    markConversationsLoaded([conversation])
    result.set(id, conversation)
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
    if (!parsed || typeof parsed !== 'object') return {}
    const limits = parsed as Record<string, RateLimitStatus>
    // Versões antigas gravavam o `resetsAt` do rate_limit_event em segundos.
    for (const limit of Object.values(limits)) {
      if (typeof limit?.resetsAt === 'number' && limit.resetsAt > 0 && limit.resetsAt < 1e12) limit.resetsAt *= 1000
    }
    return limits
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
