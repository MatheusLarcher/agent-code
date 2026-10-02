import { MEDIA_MARKER_SOURCE } from '../../shared/inlineMedia'

/**
 * Índice das conversas para a Central: um resumo curto por conversa e a lista
 * por projeto, que o decisor manda ao TypeSafe como `state`. Sem LLM.
 *
 * Tudo aqui é PURO — sem disco, sem Electron. O que depende da máquina (a pasta
 * existe? é do sandbox?) entra por parâmetro; é por isso que este arquivo não
 * importa ../sandbox (que puxa o electron pelo store). Cache, carga e feed de
 * mudanças ficam em centralIndexStore.ts.
 */

/** O que o índice lê de uma linha de `loadConversations()` (VersionedConversation, persistence/types.ts). */
export interface VersionedConversationLike {
  id: string
  /** Sem tipo no main: cada campo é validado na leitura. */
  payload: Record<string, unknown>
  revision?: number
  contentHash?: string
  createdAt?: string
  /** ISO 8601 da linha; vira o `updatedAt` do resumo quando o payload não traz um número. */
  updatedAt?: string
  deletedAt?: string
}

export interface CentralConversationSummary {
  convId: string
  /** A pasta da conversa (a subpasta, no sandbox): é para onde a mensagem é entregue. */
  cwd: string
  /** Nome da pasta do projeto; 'sandbox' para as conversas do sandbox. */
  project: string
  sandbox: boolean
  title: string
  firstRequest: string
  /** Os 2 últimos pedidos, em ordem cronológica, sem repetir o 1º (com 1 pedido: vazio; com 2: só o 2º). */
  lastRequests: string[]
  /** Até 8 arquivos criados/editados pelo agente principal, o mais recente primeiro. */
  files: string[]
  /** O começo da última resposta final ('' se a conversa ainda não teve uma). */
  answerStart: string
  /** Epoch ms. */
  updatedAt: number
}

export interface CentralProject {
  /** A pasta do projeto; no grupo do sandbox, a raiz dele. */
  cwd: string
  /** Nome da pasta; 'sandbox' no grupo do sandbox. */
  name: string
  sandbox: boolean
  /** Títulos das 5 conversas mais recentes. */
  recentTitles: string[]
  updatedAt: number
  /** Do mais recente para o mais antigo. */
  conversations: CentralConversationSummary[]
}

export interface CentralIndex {
  /** Do mais recente para o mais antigo. */
  projects: CentralProject[]
  byId: Map<string, CentralConversationSummary>
}

/** O `state` do TypeSafe aceita 32k tokens (64k por chamada): o índice usa ~24k e deixa o resto para instruções e perguntas. */
export const CENTRAL_STATE_BUDGET_TOKENS = 24_000
/** Teto de opções de uma pergunta `choice` (o mesmo de MEMORY_CHOICE_MAX_OPTIONS em typesafe/memorySelection.ts). */
export const MAX_CHOICE_OPTIONS = 255
/** Conversas de um projeto que cabem num `choice`: uma opção fica reservada para "nova conversa". */
export const MAX_PROJECT_CONVERSATIONS = MAX_CHOICE_OPTIONS - 1
/** Projetos que cabem no `choice` de projeto: uma opção fica reservada para "sem projeto". */
export const MAX_PROJECTS = MAX_CHOICE_OPTIONS - 1
/** Nome do grupo único das conversas do sandbox. */
export const SANDBOX_PROJECT_NAME = 'sandbox'

/** Teto de cada texto do resumo, em caracteres (as reticências contam). */
const TEXT_MAX_CHARS = 200
const MAX_FILES = 8
const RECENT_TITLES = 5
/** As ferramentas que criam/editam arquivo (o caminho vem em `file_path` ou `notebook_path`). */
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
/** Mesmo critério de `isCentralConversation` (shared/central.ts), por dado literal. */
const CENTRAL_ID = 'central'
/** Chave interna do grupo do sandbox: com NUL não colide com nenhuma pasta de verdade. */
const SANDBOX_GROUP = '\0sandbox'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// ---------------------------------------------------------------------------
// Texto e caminho
// ---------------------------------------------------------------------------

const MEDIA_MARKER = new RegExp(MEDIA_MARKER_SOURCE, 'g')
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g

/**
 * Texto do resumo: numa linha só, `{{midia:N}}` vira `[anexo]` e o que passa de
 * 200 caracteres é cortado com "…" (o total, reticências incluídas, é 200).
 * Não-texto vira ''.
 */
export function clipText(value: unknown): string {
  if (typeof value !== 'string') return ''
  const line = value.replace(MEDIA_MARKER, '[anexo]').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
  if (line.length <= TEXT_MAX_CHARS) return line
  let cut = line.slice(0, TEXT_MAX_CHARS - 1)
  // Meio emoji na ponta vira lixo no JSON que vai ao TypeSafe.
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1)
  return `${cut.trimEnd()}…`
}

/** Caminho com letra de unidade ou barra na frente (Windows, UNC e POSIX). */
const ABSOLUTE = /^(?:[A-Za-z]:)?[\\/]/

/** As partes do caminho (separa por \ e /), sem `.` e com `..` já resolvido. */
function pathParts(path: string): string[] {
  const parts: string[] = []
  for (const part of path.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts
}

/** O nome da pasta: a última parte do caminho. */
function folderName(cwd: string): string {
  const parts = pathParts(cwd)
  return parts[parts.length - 1] ?? cwd
}

/**
 * Como um arquivo aparece no resumo: relativo à pasta da conversa, com barras
 * normais, quando está dentro dela; senão, só o nome. Independe da plataforma
 * (a conversa pode ter vindo do outro PC) e ignora maiúsculas na pasta.
 */
export function displayPath(file: string, cwd: string): string {
  const parts = pathParts(file)
  const name = parts[parts.length - 1] ?? ''
  // Caminho relativo já é relativo à pasta da conversa, a menos que suba dela.
  if (!ABSOLUTE.test(file)) return file.split(/[\\/]/).includes('..') ? name : parts.join('/')
  const root = pathParts(cwd)
  const inside =
    root.length > 0 && root.length < parts.length && root.every((part, i) => part.toLowerCase() === parts[i].toLowerCase())
  return inside ? parts.slice(root.length).join('/') : name
}

// ---------------------------------------------------------------------------
// Resumo de uma conversa
// ---------------------------------------------------------------------------

/** O texto de cada pedido do usuário (não cancelado, não vazio), na ordem da conversa. */
function userRequests(messages: unknown[]): string[] {
  const requests: string[] = []
  for (const m of messages) {
    if (!isRecord(m) || m.kind !== 'user' || m.canceled === true) continue
    if (typeof m.text === 'string' && m.text.trim() !== '') requests.push(m.text)
  }
  return requests
}

/** Até 8 arquivos criados/editados pelo agente principal, o mais recente primeiro e sem repetir. */
function editedFiles(messages: unknown[], cwd: string): string[] {
  const files: string[] = []
  const seen = new Set<string>()
  for (let i = messages.length - 1; i >= 0 && files.length < MAX_FILES; i--) {
    const m = messages[i]
    if (!isRecord(m) || m.kind !== 'tool-use' || typeof m.name !== 'string' || !FILE_TOOLS.has(m.name)) continue
    // Trilha de subagente não é "o agente principal" (e nem entra nas mensagens, mas não custa).
    if (typeof m.parentToolUseId === 'string' && m.parentToolUseId !== '') continue
    const input = isRecord(m.input) ? m.input : {}
    const path =
      typeof input.file_path === 'string' && input.file_path !== ''
        ? input.file_path
        : typeof input.notebook_path === 'string'
          ? input.notebook_path
          : ''
    const shown = path ? clipText(displayPath(path, cwd)) : ''
    if (!shown || seen.has(shown)) continue
    seen.add(shown)
    files.push(shown)
  }
  return files
}

/** O último `assistant-text` com `answer`; sem ele, o último com `final`. Textos vazios não valem. */
function answerStart(messages: unknown[]): string {
  let lastFinal = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!isRecord(m) || m.kind !== 'assistant-text' || typeof m.text !== 'string' || m.text.trim() === '') continue
    if (m.answer === true) return clipText(m.text)
    if (lastFinal === '' && m.final === true) lastFinal = m.text
  }
  return clipText(lastFinal)
}

/** Epoch ms: o número do payload; sem ele, o ISO da linha; sem nenhum, 0. */
function epochMs(fromPayload: unknown, fromRow: unknown): number {
  if (typeof fromPayload === 'number' && Number.isFinite(fromPayload)) return fromPayload
  const parsed = typeof fromRow === 'string' ? Date.parse(fromRow) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * O resumo de uma linha de `loadConversations()`, ou null quando a conversa não
 * é candidata: a Central, planejamento, apagada, sem pasta ou payload malformado.
 * Nunca lança por causa do conteúdo; `isSandbox` é do chamador. Se a pasta
 * existe nesta máquina é decisão do `buildCentralIndex`, não daqui.
 */
export function summarizeConversation(
  row: VersionedConversationLike,
  isSandbox: (cwd: string) => boolean
): CentralConversationSummary | null {
  if (!isRecord(row) || typeof row.id !== 'string' || row.id === '') return null
  const payload: unknown = row.payload
  if (!isRecord(payload)) return null
  if (row.deletedAt || payload.deletedAt) return null
  if (payload.mode === 'central' || payload.mode === 'planning') return null
  if (row.id === CENTRAL_ID || payload.id === CENTRAL_ID) return null
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : ''
  if (cwd.trim() === '') return null
  const messages: unknown = payload.messages ?? []
  if (!Array.isArray(messages)) return null

  const requests = userRequests(messages)
  const sandbox = Boolean(isSandbox(cwd))
  return {
    convId: row.id,
    cwd,
    project: sandbox ? SANDBOX_PROJECT_NAME : folderName(cwd),
    sandbox,
    title: clipText(payload.title),
    firstRequest: clipText(requests[0]),
    lastRequests: requests.slice(1).slice(-2).map((text) => clipText(text)),
    files: editedFiles(messages, cwd),
    answerStart: answerStart(messages),
    updatedAt: epochMs(payload.updatedAt, row.updatedAt)
  }
}

// ---------------------------------------------------------------------------
// O índice
// ---------------------------------------------------------------------------

export interface BuildCentralIndexOptions {
  /** A raiz do sandbox: é o `cwd` do grupo único das conversas dele. */
  sandboxRoot: string
  /** A pasta existe nesta máquina? (quem monta injeta `fs.existsSync`) */
  exists(path: string): boolean
}

const byRecency = (a: CentralConversationSummary, b: CentralConversationSummary): number =>
  b.updatedAt - a.updatedAt || compare(a.convId, b.convId)

/**
 * Agrupa os resumos por projeto (a pasta da conversa). Ficam de fora a pasta que
 * não existe nesta máquina e, por consequência, o projeto sem conversa restante
 * (projeto nunca é adivinhado). As conversas do sandbox, cada uma na sua
 * subpasta, formam UM grupo com a raiz como `cwd`. Tudo do mais recente para o
 * mais antigo.
 */
export function buildCentralIndex(
  summaries: Iterable<CentralConversationSummary>,
  options: BuildCentralIndexOptions
): CentralIndex {
  // Uma consulta ao disco por pasta; erro de acesso conta como ausente.
  const present = new Map<string, boolean>()
  const folderExists = (cwd: string): boolean => {
    let ok = present.get(cwd)
    if (ok === undefined) {
      try {
        ok = Boolean(options.exists(cwd))
      } catch {
        ok = false
      }
      present.set(cwd, ok)
    }
    return ok
  }

  const groups = new Map<string, CentralConversationSummary[]>()
  for (const summary of summaries) {
    if (!folderExists(summary.cwd)) continue
    const key = summary.sandbox ? SANDBOX_GROUP : summary.cwd
    const group = groups.get(key)
    if (group) group.push(summary)
    else groups.set(key, [summary])
  }

  const projects: CentralProject[] = []
  const byId = new Map<string, CentralConversationSummary>()
  for (const [key, conversations] of groups) {
    conversations.sort(byRecency)
    for (const conversation of conversations) byId.set(conversation.convId, conversation)
    const sandbox = key === SANDBOX_GROUP
    projects.push({
      cwd: sandbox ? options.sandboxRoot : key,
      name: sandbox ? SANDBOX_PROJECT_NAME : folderName(key),
      sandbox,
      recentTitles: conversations
        .slice(0, RECENT_TITLES)
        .map((conversation) => conversation.title)
        .filter((title) => title !== ''),
      updatedAt: conversations[0].updatedAt,
      conversations
    })
  }
  projects.sort((a, b) => b.updatedAt - a.updatedAt || compare(a.name, b.name) || compare(a.cwd, b.cwd))
  return { projects, byId }
}

// ---------------------------------------------------------------------------
// Orçamento do `state`
// ---------------------------------------------------------------------------

/** Estimativa conservadora (subestimar estoura o `state`): 3,5 caracteres por token. O repositório não tem outra para reaproveitar. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

/** Tokens de um resumo, pelo JSON que vai ao TypeSafe. */
export function summaryTokens(summary: CentralConversationSummary): number {
  return estimateTokens(JSON.stringify(summary))
}

/** Tokens do projeto sem as conversas: nome, pasta e os títulos recentes. */
export function projectHeaderTokens(project: CentralProject): number {
  const { name, cwd, sandbox, recentTitles } = project
  return estimateTokens(JSON.stringify({ name, cwd, sandbox, recentTitles }))
}

/**
 * Fica com os itens mais recentes (a lista vem do mais recente para o mais
 * antigo) enquanto couberem em `budgetTokens`, e com no máximo `maxItems`.
 * Para no primeiro que não cabe: nunca pula um recente para guardar um antigo menor.
 */
export function fitToBudget<T>(
  items: readonly T[],
  budgetTokens: number,
  size: (item: T) => number,
  maxItems = Infinity
): T[] {
  const kept: T[] = []
  let used = 0
  for (const item of items) {
    if (kept.length >= maxItems) break
    const next = used + size(item)
    if (!(next <= budgetTokens)) break
    kept.push(item)
    used = next
  }
  return kept
}

/**
 * O índice que vai ao TypeSafe. Primeiro os projetos: os 254 mais recentes (cabem
 * no `choice` com o "sem projeto"; o grupo do sandbox conta como os outros) cujos
 * cabeçalhos cabem no orçamento. Um projeto mantido fica mesmo sem conversa no
 * orçamento (ainda pode receber uma conversa nova). Depois, no que sobra, as
 * conversas desses projetos — no máximo 254 por projeto (cabem no `choice` com a
 * "nova conversa") e só as mais recentes de TODAS juntas. `byId` só tem as
 * conversas mantidas: é a lista oferecida.
 */
export function fitIndexToBudget(index: CentralIndex, budgetTokens = CENTRAL_STATE_BUDGET_TOKENS): CentralIndex {
  const offered = fitToBudget(index.projects, budgetTokens, projectHeaderTokens, MAX_PROJECTS)
  const headers = offered.reduce((total, project) => total + projectHeaderTokens(project), 0)
  const capped = offered.map((project) => project.conversations.slice(0, MAX_PROJECT_CONVERSATIONS))
  const kept = new Set(fitToBudget(capped.flat().sort(byRecency), budgetTokens - headers, summaryTokens))

  const byId = new Map<string, CentralConversationSummary>()
  const projects = offered.map((project, i) => {
    const conversations = capped[i].filter((conversation) => kept.has(conversation))
    for (const conversation of conversations) byId.set(conversation.convId, conversation)
    return { ...project, conversations }
  })
  return { projects, byId }
}
