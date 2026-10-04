import { readdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import parquet from 'parquetjs-lite'
import { readableMediaText } from '../../../shared/inlineMedia'
import { clipText, summarizeConversation, type VersionedConversationLike } from '../centralIndex'

/**
 * Calibração da Central (Etapa 8), parte 1: o histórico REAL, só leitura. Lê a
 * exportação parquet diária (uma linha por conversa; as de memória ficam de
 * fora), aplica as mesmas exclusões do índice e devolve, por conversa, os
 * pedidos do usuário com a hora de cada um. Não grava nada e não fala com a rede.
 */

const EXPORT_DIRNAME = 'memorias-longo-praso'
const EXPORT_FILE = /^conversas_agent-code_\d{4}-\d{2}-\d{2}\.parquet$/
/** Os tetos do pedido de rota da tela (centralRecents/centralDelivery). */
const ROUTE_TEXT_MAX_CHARS = 20_000
const MAX_ATTACHMENT_NAMES = 20
const ATTACHMENT_NAME_MAX = 200
/** Mesmo critério de `isCentralConversation`, por dado literal. */
const CENTRAL_ID = 'central'

export type ExclusionReason = 'malformed' | 'deleted' | 'central' | 'planning' | 'empty-cwd' | 'folder-missing'

export interface ExportRows {
  rows: VersionedConversationLike[]
  /** Linhas `tipo: 'conversa'` lidas (as malformadas inclusive). */
  total: number
  /** `conteudo` que não é um objeto JSON. */
  malformed: number
}

export interface HistoryRequest {
  /** O id da bolha do usuário (`<conversa>#<posição>` quando falta). */
  id: string
  convId: string
  /** Posição na lista de mensagens da conversa. */
  position: number
  /** O texto como a Central o manda ao decisor: legível; só anexos = os nomes. */
  text: string
  /** Só os nomes. */
  attachments: string[]
  /** Epoch ms: a `ts` da bolha ou, sem ela, interpolada. */
  t: number
  interpolated: boolean
  /** A 1ª mensagem da conversa (a que a abriu). */
  first: boolean
}

export interface HistoryConversation {
  id: string
  /** A linha como o índice a lê. */
  row: VersionedConversationLike
  cwd: string
  sandbox: boolean
  title: string
  /** Cópia importada de outra conversa (`legacyConflictOf`). */
  conflict: boolean
  createdAt: number
  updatedAt: number
  messages: unknown[]
  /** Hora de corte de cada mensagem (ver `cutTimes`). */
  times: number[]
  /** Posições dos pedidos que o índice conta (não cancelados, com texto). */
  requestPositions: number[]
  /** Os pedidos avaliados, na ordem (sem os cancelados e sem repetir os de uma cópia de conflito). */
  requests: HistoryRequest[]
}

export interface HistoryStats {
  conversations: number
  excluded: Record<ExclusionReason, number>
  eligible: number
  sandboxConversations: number
  projects: number
  userMessages: number
  canceled: number
  /** Sem texto e sem anexo: não há o que rotear. */
  withoutContent: number
  /** Já avaliadas na conversa original (cópia de conflito). */
  duplicates: number
  interpolated: number
  requests: number
}

export interface History {
  conversations: HistoryConversation[]
  /** Todos os pedidos avaliados, em ordem de tempo. */
  requests: HistoryRequest[]
  stats: HistoryStats
}

export interface HistoryDeps {
  /** A pasta existe nesta máquina? */
  exists(path: string): boolean
  /** A pasta é do sandbox? */
  isSandbox(cwd: string): boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

function isoMs(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

/** `cwd` dentro da raiz do sandbox: o mesmo `isInsideSandbox` de ../sandbox (que puxa o electron e não entra aqui). */
export function isInsideSandbox(root: string, cwd: string): boolean {
  if (!root || !cwd) return false
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  const rel = relative(fold(resolve(root)), fold(resolve(cwd)))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** A exportação mais nova em `<dataDir>/memorias-longo-praso` (pelo nome, que traz a data), ou null. */
export function newestExport(dataDir: string): string | null {
  const dir = join(dataDir, EXPORT_DIRNAME)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  const newest = names.filter((name) => EXPORT_FILE.test(name)).sort().pop()
  return newest ? join(dir, newest) : null
}

/** JSON ruim vira null SEM a mensagem do erro: o Node cita nela um pedaço do texto (conteúdo do usuário). */
function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** As linhas `tipo: 'conversa'` da exportação, como o índice as lê. */
export async function readExport(file: string): Promise<ExportRows> {
  const reader = await parquet.ParquetReader.openFile(file)
  const rows: VersionedConversationLike[] = []
  let total = 0
  let malformed = 0
  try {
    const cursor = reader.getCursor()
    for (let row = await cursor.next(); row; row = await cursor.next()) {
      if (row.tipo !== 'conversa') continue
      total++
      const payload = parseObject(row.conteudo)
      if (!payload) {
        malformed++
        continue
      }
      const id = typeof row.id === 'string' && row.id ? row.id : typeof payload.id === 'string' ? payload.id : ''
      rows.push({
        id,
        payload,
        createdAt: typeof row.criadoEm === 'string' ? row.criadoEm : undefined,
        updatedAt: typeof row.atualizadoEm === 'string' ? row.atualizadoEm : undefined
      })
    }
  } finally {
    await reader.close()
  }
  return { rows, total, malformed }
}

function safeExists(exists: (path: string) => boolean, path: string): boolean {
  try {
    return Boolean(exists(path))
  } catch {
    return false
  }
}

/** Por que a conversa fica fora do índice (na ordem de `summarizeConversation`, e a pasta por último, como `buildCentralIndex`). */
function exclusion(row: VersionedConversationLike, deps: HistoryDeps): ExclusionReason | null {
  const payload: unknown = row?.payload
  if (!isRecord(payload) || typeof row.id !== 'string' || row.id === '') return 'malformed'
  if (row.deletedAt || payload.deletedAt) return 'deleted'
  if (payload.mode === 'central' || row.id === CENTRAL_ID || payload.id === CENTRAL_ID) return 'central'
  if (payload.mode === 'planning') return 'planning'
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : ''
  if (cwd.trim() === '') return 'empty-cwd'
  // O resumidor do índice é a autoridade: o que ele recusa por outro motivo é malformado.
  if (!summarizeConversation(row, deps.isSandbox)) return 'malformed'
  return safeExists(deps.exists, cwd) ? null : 'folder-missing'
}

const tsOf = (message: unknown): number | null => (isRecord(message) ? finite(message.ts) : null)

/**
 * Hora de corte de cada mensagem: a `ts` dela; sem ela, a da próxima que tem (o
 * `updatedAt` depois da última); e nunca menor que a da anterior. É um limite de
 * CIMA: a mensagem só entra num recorte no tempo depois de ter acontecido.
 */
export function cutTimes(messages: readonly unknown[], updatedAt: number): number[] {
  const raw = new Array<number>(messages.length)
  let next = updatedAt
  for (let i = messages.length - 1; i >= 0; i--) {
    const ts = tsOf(messages[i])
    if (ts !== null) next = ts
    raw[i] = next
  }
  let floor = Number.NEGATIVE_INFINITY
  return raw.map((t) => (floor = Math.max(floor, t)))
}

/** A hora de cada pedido: a `ts`; sem ela, interpolada entre os vizinhos que têm (createdAt e updatedAt nas pontas). */
export function userTimes(
  ts: ReadonlyArray<number | null>,
  createdAt: number,
  updatedAt: number
): { t: number; interpolated: boolean }[] {
  const out = ts.map((t) => ({ t: t ?? Number.NaN, interpolated: t === null }))
  for (let i = 0; i < out.length; ) {
    if (!out[i].interpolated) {
      i++
      continue
    }
    let j = i
    while (j < out.length && out[j].interpolated) j++
    const before = i > 0 ? out[i - 1].t : createdAt
    const after = Math.max(j < out.length ? out[j].t : updatedAt, before)
    for (let k = i; k < j; k++) out[k].t = before + ((after - before) * (k - i + 1)) / (j - i + 1)
    i = j
  }
  return out
}

/** Os nomes dos anexos da bolha: imagens com rótulo (`media`) e arquivos, com os tetos da tela. */
function attachmentNames(message: Record<string, unknown>): string[] {
  const names: string[] = []
  for (const media of Array.isArray(message.media) ? message.media : []) {
    if (isRecord(media) && media.t === 'i' && typeof media.name === 'string' && media.name) names.push(media.name)
  }
  for (const file of Array.isArray(message.files) ? message.files : []) {
    if (isRecord(file) && typeof file.name === 'string' && file.name) names.push(file.name)
  }
  return names.slice(0, MAX_ATTACHMENT_NAMES).map((name) => name.slice(0, ATTACHMENT_NAME_MAX))
}

/** O `routeText` da tela: legível; só anexos = os nomes; sem nenhum dos dois, null (não há o que rotear). */
function routeText(text: string, attachments: readonly string[]): string | null {
  const readable = readableMediaText(text).trim()
  if (readable) return readable.slice(0, ROUTE_TEXT_MAX_CHARS)
  return attachments.length ? `[anexos: ${attachments.join(', ')}]`.slice(0, ROUTE_TEXT_MAX_CHARS) : null
}

function conversationOf(row: VersionedConversationLike, deps: HistoryDeps): HistoryConversation {
  const payload = row.payload
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  const createdAt = finite(payload.createdAt) ?? isoMs(row.createdAt) ?? 0
  const updatedAt = Math.max(finite(payload.updatedAt) ?? isoMs(row.updatedAt) ?? createdAt, createdAt)
  const cwd = payload.cwd as string
  const requestPositions: number[] = []
  messages.forEach((m, position) => {
    if (isRecord(m) && m.kind === 'user' && m.canceled !== true && typeof m.text === 'string' && m.text.trim() !== '') {
      requestPositions.push(position)
    }
  })
  return {
    id: row.id,
    row,
    cwd,
    sandbox: Boolean(deps.isSandbox(cwd)),
    title: clipText(payload.title),
    conflict: typeof payload.legacyConflictOf === 'string' && payload.legacyConflictOf !== '',
    createdAt,
    updatedAt,
    messages,
    times: cutTimes(messages, updatedAt),
    requestPositions,
    requests: []
  }
}

/** Os pedidos avaliados de uma conversa; `seen` = ids já avaliados (a cópia de conflito repete os da original). */
function requestsOf(conv: HistoryConversation, seen: Set<string>, stats: HistoryStats): HistoryRequest[] {
  const live: { position: number; message: Record<string, unknown> }[] = []
  conv.messages.forEach((message, position) => {
    if (!isRecord(message) || message.kind !== 'user') return
    stats.userMessages++
    if (message.canceled === true) stats.canceled++
    else live.push({ position, message })
  })
  const times = userTimes(
    live.map(({ message }) => tsOf(message)),
    conv.createdAt,
    conv.updatedAt
  )
  const out: HistoryRequest[] = []
  let first = true
  live.forEach(({ position, message }, k) => {
    const attachments = attachmentNames(message)
    const text = routeText(typeof message.text === 'string' ? message.text : '', attachments)
    if (text === null) {
      stats.withoutContent++
      return
    }
    const opens = first
    first = false
    const id = typeof message.id === 'string' && message.id ? message.id : `${conv.id}#${position}`
    if (seen.has(id)) {
      stats.duplicates++
      return
    }
    seen.add(id)
    if (times[k].interpolated) stats.interpolated++
    out.push({ id, convId: conv.id, position, text, attachments, t: times[k].t, interpolated: times[k].interpolated, first: opens })
  })
  return out
}

/** O histórico avaliável: exclusões do índice, horas, e cada pedido uma vez só. */
export function buildHistory(source: ExportRows, deps: HistoryDeps): History {
  const excluded: Record<ExclusionReason, number> = {
    malformed: source.malformed,
    deleted: 0,
    central: 0,
    planning: 0,
    'empty-cwd': 0,
    'folder-missing': 0
  }
  const conversations: HistoryConversation[] = []
  for (const row of source.rows) {
    const reason = exclusion(row, deps)
    if (reason) excluded[reason]++
    else conversations.push(conversationOf(row, deps))
  }
  // A original antes da cópia de conflito (o mesmo createdAt): a mensagem repetida é avaliada na original.
  conversations.sort((a, b) => a.createdAt - b.createdAt || Number(a.conflict) - Number(b.conflict) || compare(a.id, b.id))
  const stats: HistoryStats = {
    conversations: source.total,
    excluded,
    eligible: conversations.length,
    sandboxConversations: conversations.filter((c) => c.sandbox).length,
    projects: new Set(conversations.filter((c) => !c.sandbox).map((c) => c.cwd)).size,
    userMessages: 0,
    canceled: 0,
    withoutContent: 0,
    duplicates: 0,
    interpolated: 0,
    requests: 0
  }
  const seen = new Set<string>()
  for (const conv of conversations) conv.requests = requestsOf(conv, seen, stats)
  const requests = conversations
    .flatMap((conv) => conv.requests)
    .sort((a, b) => a.t - b.t || compare(a.convId, b.convId) || a.position - b.position)
  stats.requests = requests.length
  return { conversations, requests, stats }
}
