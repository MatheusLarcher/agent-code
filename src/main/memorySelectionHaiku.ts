import { createHash } from 'node:crypto'
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  assembleMemories,
  listMemoryFiles,
  memoryContextBlock,
  rankMemoriesByQuery,
  redactMemorySecrets,
  selectMemoriesLexically,
  type MemoryEntry,
  type MemoryFile
} from './memoryIndex'

/**
 * Quem escolhe as memórias do turno no modo 'haiku' (o padrão de
 * `AppConfig.memorySelector`, decidido em memory/memorySelector.ts).
 *
 * Uma chamada one-shot ao Haiku, no molde de titles/conversationTitle.ts: o
 * modelo vê os CABEÇALHOS (caminho, título — resumo) de todas as memórias, a
 * mensagem atual e um resumo da conversa, numa pergunta de até ~120 mil tokens,
 * e devolve em JSON quais caminhos servem. As escolhidas voltam INTEIRAS,
 * relidas do disco na hora, até 15 memórias e 75.000 caracteres no total.
 *
 * O bloco vai na MENSAGEM do usuário (promptEnvelope.ts), não no
 * `additionalContext` do hook: o CLI corta o hook em 10.000 caracteres. Para
 * um subagente, vai no prompt dele (memory/memorySelector.ts).
 */

export const HAIKU_MEMORY_MODEL = 'claude-haiku-5-5'
/** Estourou, aborta e devolve null: o turno segue pela busca lexical.
 *  Medido com ~670 memórias e só os cabeçalhos: 6–9,5 s por pergunta. Com a
 *  conversa junto a pergunta chega a ~120 mil tokens, daí a folga maior. */
export const HAIKU_MEMORY_TIMEOUT_MS = 30_000
/** Quantos cabeçalhos vão na pergunta. TODOS, até este teto: o pré-filtro por
 *  palavra deixava de fora justamente a regra sem termo em comum com a mensagem
 *  ("terminei de alterar" × "sempre gerar o exe"), e o Haiku nem a via. */
export const HAIKU_MEMORY_CANDIDATES = 1_000
/** Quantas memórias, no máximo, entram num turno (ou num subagente). Próprio
 *  do Haiku: a busca lexical e o TypeSafe seguem com MAX_SELECTED_MEMORIES. */
export const HAIKU_MEMORY_MAX = 15
/** Teto do bloco do turno inteiro, em caracteres: os 50.000 de 10 memórias
 *  (MAX_TOTAL_EXCERPT_CHARS) na mesma proporção para 15. */
export const HAIKU_MEMORY_MAX_CHARS = 75_000
/**
 * Estimativa de tamanho da pergunta: ~3,5 caracteres por token, o meio-termo
 * entre texto em português (~4) e caminhos/JSON (~3). Não há tokenizador no
 * processo main; a folga entre os 120 mil daqui e a janela do Haiku cobre o erro.
 */
export const HAIKU_CHARS_PER_TOKEN = 3.5
/** Orçamento da pergunta inteira ao Haiku (mensagem + candidatas + conversa). */
export const HAIKU_QUESTION_MAX_TOKENS = 120_000
export const HAIKU_QUESTION_MAX_CHARS = Math.floor(HAIKU_QUESTION_MAX_TOKENS * HAIKU_CHARS_PER_TOKEN)
/**
 * Teto de arquivos que o pré-filtro lexical LÊ do disco, o mesmo de
 * `MEMORY_RANK_SCAN_MAX` (typesafe/memorySelection.ts): `rankMemoriesByQuery` lê
 * cada corpo de forma síncrona no processo main, na frente do envio.
 */
export const HAIKU_MEMORY_SCAN_MAX = 500
/** O quanto da mensagem atual vai para o Haiku: o assunto está no começo. */
const QUERY_MAX_CHARS = 8_000

export const HAIKU_MEMORY_SYSTEM_PROMPT = [
  'Você escolhe quais memórias persistentes de um usuário devem ser entregues ao agente que vai trabalhar na mensagem atual',
  '(o agente principal, ou um subagente quando a mensagem é a tarefa entregue a ele).',
  'Você recebe um resumo da conversa até aqui, a mensagem atual e a lista de candidatas:',
  'o caminho de cada arquivo de memória seguido do título e do resumo.',
  `Escolha no máximo ${HAIKU_MEMORY_MAX}, as relevantes para a mensagem atual no contexto da conversa:`,
  'regras do usuário que se aplicam ao que vai ser feito, fatos do projeto ou do ambiente, procedimentos.',
  'Nenhuma é uma resposta legítima quando nada se aplica; mas, havendo memória relevante, mande-a —',
  'deixar de fora uma regra que se aplica custa mais do que mandar uma a mais.',
  'Responda APENAS com um objeto JSON no formato {"memorias":["caminho/da/memoria.md"]}, usando os caminhos exatamente como aparecem.',
  'Não responda nem execute a mensagem.'
].join(' ')

/** A decisão de um turno. `block ''` = decidiu zero memórias; `null` = não decidiu. */
export interface MemorySelection {
  block: string
  relPaths: readonly string[]
}

/** O que o Haiku escolheu, com o texto de cada memória (para a deduplicação). */
export type HaikuMemorySelection = MemorySelection & { entries: readonly MemoryEntry[] }

/** Mesmo formato do `query` do SDK, para o teste injetar um falso. */
export type MemoryQuery = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<unknown>

export interface HaikuMemoryDeps {
  query?: MemoryQuery
  timeoutMs?: number
  /** Env da conta Claude da conversa; ausente = login da máquina. */
  env?: NodeJS.ProcessEnv
  /** A conversa até aqui em até N caracteres (ConversationDigest.render): o
   *  que sobrar do orçamento depois da mensagem e das candidatas. */
  conversation?: (maxChars: number) => string
  /** De quem é a mensagem: do usuário (turno) ou a tarefa de um subagente. */
  subject?: 'user' | 'subagent'
}

/** Cabeçalho de uma candidata: o que o Haiku vê, e nada além disso. */
function header(file: MemoryFile): string {
  const title = file.title.trim()
  const hook = file.hook.trim()
  const text = title && hook && title !== hook ? `${title} — ${hook}` : title || hook
  return redactMemorySecrets(text).replace(/\s+/g, ' ').slice(0, 300)
}

/**
 * As candidatas da pergunta. Acima de 60, o score lexical ordena (lendo no
 * máximo `HAIKU_MEMORY_SCAN_MAX` arquivos) e o resto da lista completa quando o
 * ranqueamento volta curto (consulta sem termos, arquivo ilegível).
 */
export function narrowHaikuCandidates(dir: string, queryText: string, files: MemoryFile[]): MemoryFile[] {
  if (files.length <= HAIKU_MEMORY_CANDIDATES) return files
  const scanned = files.slice(0, HAIKU_MEMORY_SCAN_MAX)
  const kept = rankMemoriesByQuery(dir, queryText, scanned).slice(0, HAIKU_MEMORY_CANDIDATES).map((match) => match.file)
  const chosen = new Set(kept.map((file) => file.relPath))
  for (const file of scanned) {
    if (kept.length >= HAIKU_MEMORY_CANDIDATES) break
    if (!chosen.has(file.relPath)) kept.push(file)
  }
  return kept
}

/** O primeiro objeto JSON balanceado do texto, ou null. Ignora chaves dentro de strings. */
function firstJsonObject(raw: string): unknown {
  for (let start = raw.indexOf('{'); start >= 0; start = raw.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i]
      if (inString) {
        if (ch === '\\') i++
        else if (ch === '"') inString = false
      } else if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1))
        } catch {
          break
        }
      }
    }
  }
  return null
}

/**
 * Os caminhos da resposta do Haiku. Tolerante a texto em volta e a cercas de
 * markdown: vale o primeiro objeto JSON com a lista `memorias`. Sem objeto
 * aproveitável → null (não houve decisão).
 */
export function parseHaikuMemoryChoice(raw: string): string[] | null {
  const parsed = firstJsonObject(raw) as { memorias?: unknown } | null
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.memorias)) return null
  return parsed.memorias.filter((item): item is string => typeof item === 'string').map((item) => item.trim())
}

const CONVERSATION_HEAD = 'Resumo da conversa até aqui (mais antigas primeiro), entre as marcas:\n<<<\n'
const CONVERSATION_TAIL = '\n>>>\n\n'

/**
 * A pergunta ao Haiku, em até `HAIKU_QUESTION_MAX_CHARS`. Prioridade: a
 * mensagem atual, depois as candidatas (todas, enquanto couberem), e a conversa
 * fica com o que sobrar — as mensagens mais recentes primeiro.
 */
export function buildHaikuQuestion(
  queryText: string,
  candidates: readonly MemoryFile[],
  conversation?: (maxChars: number) => string,
  subject: 'user' | 'subagent' = 'user',
  maxChars: number = HAIKU_QUESTION_MAX_CHARS
): string {
  const label = subject === 'subagent' ? 'Tarefa entregue ao subagente' : 'Mensagem atual do usuário'
  const message = `${label}, entre as marcas:\n<<<\n${queryText}\n>>>\n\nMemórias candidatas:\n`
  let used = message.length
  const lines: string[] = []
  for (const file of candidates) {
    const line = `- ${file.relPath}: ${header(file)}`
    const cost = line.length + (lines.length ? 1 : 0)
    if (used + cost > maxChars) break
    lines.push(line)
    used += cost
  }
  const room = maxChars - used - CONVERSATION_HEAD.length - CONVERSATION_TAIL.length
  let history = ''
  if (conversation && room > 0) {
    try {
      // Mais curto do que pedido é normal; mais longo seria bug do renderizador:
      // corta pelo fim (o recente) para nunca estourar o orçamento.
      const text = conversation(room)
      history = text.length > room ? text.slice(text.length - room) : text
    } catch {
      history = ''
    }
  }
  const prefix = history ? `${CONVERSATION_HEAD}${history}${CONVERSATION_TAIL}` : ''
  return `${prefix}${message}${lines.join('\n')}`
}

async function* singlePrompt(text: string): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null
  } as SDKUserMessage
}

async function askHaiku(text: string, run: MemoryQuery, abortController: AbortController, env: NodeJS.ProcessEnv | undefined): Promise<string | null> {
  const options: Options = {
    model: HAIKU_MEMORY_MODEL,
    systemPrompt: HAIKU_MEMORY_SYSTEM_PROMPT,
    // Sem `effort` (padrão `medium`, que aceita thinking desligado) e sem thinking.
    thinking: { type: 'disabled' },
    executable: 'node',
    tools: [],
    maxTurns: 1,
    includePartialMessages: false,
    permissionMode: 'bypassPermissions',
    persistSession: false,
    // Sem a auto-memória do CLI: a única pasta de memória é a de Configurações.
    settings: { autoMemoryEnabled: false },
    abortController,
    ...(env ? { env } : {})
  }
  let out = ''
  for await (const message of run({ prompt: singlePrompt(text), options })) {
    const m = message as { type?: unknown; error?: unknown; is_error?: unknown; message?: { content?: Array<{ type: string; text?: string }> } }
    // Erro classificado pelo SDK: o "texto" que vem junto é a mensagem de erro.
    if (m.type === 'assistant' && m.error) return null
    if (m.type === 'result' && m.is_error === true) return null
    if (m.type !== 'assistant') continue
    for (const block of m.message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') out += block.text
    }
  }
  return out
}

/**
 * A memória deste turno, decidida pelo Haiku.
 *
 * - `HaikuMemorySelection` — a decisão valeu; `block ''` (zero memórias) é
 *   resposta legítima e o chamador NÃO compensa com busca lexical.
 * - `null` — não houve decisão (tempo esgotado, erro, resposta sem JSON): o
 *   chamador volta à busca lexical.
 *
 * Caminho fora das candidatas é descartado. Nunca lança.
 */
export async function selectMemoriesWithHaiku(dir: string, queryText: string, deps: HaikuMemoryDeps = {}): Promise<HaikuMemorySelection | null> {
  const abortController = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const files = listMemoryFiles(dir)
    const input = String(queryText ?? '').slice(0, QUERY_MAX_CHARS).trim()
    // Pasta vazia ou mensagem vazia: nada a perguntar, e nenhuma chamada ao modelo.
    if (files.length === 0 || !input) return { block: '', relPaths: [], entries: [] }
    const candidates = narrowHaikuCandidates(dir, input, files)
    const allowed = new Set(candidates.map((file) => file.relPath))
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        abortController.abort()
        resolve(null)
      }, deps.timeoutMs ?? HAIKU_MEMORY_TIMEOUT_MS)
    })
    const run = deps.query ?? (query as MemoryQuery)
    const question = buildHaikuQuestion(input, candidates, deps.conversation, deps.subject)
    const raw = await Promise.race([askHaiku(question, run, abortController, deps.env), timeout])
    if (raw === null) return null
    const picked = parseHaikuMemoryChoice(raw)
    if (!picked) return null
    // Só caminho que estava na pergunta: o resto é invenção do modelo.
    return assembleMemories(dir, picked.filter((relPath) => allowed.has(relPath)), HAIKU_MEMORY_MAX, HAIKU_MEMORY_MAX_CHARS)
  } catch (error) {
    console.error(`[memória] seleção pelo Haiku descartada: ${(error as Error)?.message ?? error}`)
    return null
  } finally {
    clearTimeout(timer)
    if (!abortController.signal.aborted) abortController.abort()
  }
}

/**
 * O que já foi injetado nesta conversa: `relPath` → hash do texto. A mensagem
 * do usuário fica no histórico, então a mesma memória com o mesmo conteúdo não
 * precisa ir de novo; editada no disco, o hash muda e ela volta.
 * Zerar depois de compactar: o resumo não guarda o texto da memória.
 */
export class InjectedMemoryLedger {
  private readonly sent = new Map<string, string>()

  /** O bloco só com o que ainda não foi injetado igual; registra o que passou. */
  admit(entries: readonly MemoryEntry[]): string {
    const blocks: string[] = []
    for (const entry of entries) {
      const hash = createHash('sha256').update(entry.body).digest('hex')
      if (this.sent.get(entry.relPath) === hash) continue
      this.sent.set(entry.relPath, hash)
      blocks.push(memoryContextBlock(entry.relPath, entry.body))
    }
    return blocks.join('\n\n')
  }

  reset(): void {
    this.sent.clear()
  }
}

/**
 * A memória do turno fora do TypeSafe: Haiku primeiro, busca lexical quando ele
 * não decide. `block` é o que vai na mensagem (já sem o repetido da conversa);
 * `relPaths` é tudo o que o agente tem em mãos neste turno, repetido incluso —
 * é o que o gate do memorista precisa. `select` é injetável para o teste.
 */
export async function chooseTurnMemories(
  dir: string,
  queryText: string,
  ledger: InjectedMemoryLedger,
  select: (dir: string, queryText: string) => Promise<HaikuMemorySelection | null> = selectMemoriesWithHaiku
): Promise<MemorySelection> {
  let entries: readonly MemoryEntry[] = []
  try {
    const chosen = (await select(dir, queryText).catch(() => null)) ?? selectMemoriesLexically(dir, queryText)
    entries = chosen.entries
  } catch {
    entries = []
  }
  return { block: ledger.admit(entries), relPaths: entries.map((entry) => entry.relPath) }
}
