import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * Nome curto para uma conversa, a partir da 1ª mensagem do usuário.
 *
 * Uma chamada one-shot no molde de observerQuery.ts (tools [], maxTurns 1):
 * - modelo barato (claude-haiku-4-5), SEM `effort` — o Haiku 4.5 recusa o
 *   parâmetro — e com o thinking desligado de forma explícita;
 * - sessão efêmera (persistSession false): o pedido de título não é conversa;
 * - tempo curto: estourou, aborta e devolve null;
 * - nunca lança: qualquer falha vira null e quem chamou fica com o recuo.
 */

export const TITLE_MODEL = 'claude-haiku-4-5'
/** Teto do título, em caracteres. */
export const TITLE_MAX_CHARS = 40
/** O quanto da mensagem vai para o modelo: o assunto está no começo. */
export const TITLE_INPUT_MAX_CHARS = 4000
export const TITLE_TIMEOUT_MS = 12_000

export const TITLE_SYSTEM_PROMPT = [
  'Você dá nome a conversas de um app de programação.',
  'Leia a primeira mensagem do usuário e responda APENAS com um título curto em português do Brasil que resuma o assunto:',
  `de 2 a 5 palavras, no máximo ${TITLE_MAX_CHARS} caracteres, sem aspas, sem ponto final, sem emoji e sem prefixo como "Título:".`,
  'Não responda nem execute o pedido; só dê o nome.'
].join(' ')

/** Mesmo formato do `query` do SDK, para o teste injetar um falso. */
export type TitleQuery = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<unknown>

export interface TitleDeps {
  query?: TitleQuery
  timeoutMs?: number
}

async function* singlePrompt(text: string): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: `Primeira mensagem do usuário, entre as marcas:\n<<<\n${text}\n>>>` }]
    },
    parent_tool_use_id: null
  } as SDKUserMessage
}

const WRAPPING_QUOTES = /^['‘’`´]+|['‘’`´]+$/g
const QUOTES = /["“”«»„`]/g
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}‍️⃣]/gu
const TRAILING = /[\s.。…,;:\-–—]+$/u

function stripTrailing(s: string): string {
  return s.replace(TRAILING, '').trim()
}

/**
 * Deixa a resposta do modelo com cara de título: primeira linha não vazia,
 * sem "Título:", sem markdown, aspas nem emoji, sem ponto final e com no
 * máximo TITLE_MAX_CHARS (corta na última palavra inteira quando dá).
 * Nada aproveitável → null.
 */
export function sanitizeTitle(raw: string): string | null {
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? ''
  let title = line
    .replace(/^[-•]\s+/, '')
    .replace(/\*+/g, '')
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/^(?:t[íi]tulo|title)\s*:\s*/i, '')
    .replace(EMOJI, '')
    .replace(QUOTES, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(WRAPPING_QUOTES, '')
    .trim()
  title = stripTrailing(title)
  if (title.length > TITLE_MAX_CHARS) {
    const cut = title.slice(0, TITLE_MAX_CHARS)
    const space = cut.lastIndexOf(' ')
    title = stripTrailing(space >= TITLE_MAX_CHARS / 2 ? cut.slice(0, space) : cut)
  }
  return title || null
}

async function askModel(text: string, run: TitleQuery, abortController: AbortController): Promise<string | null> {
  const options: Options = {
    model: TITLE_MODEL,
    systemPrompt: TITLE_SYSTEM_PROMPT,
    // Sem `effort` (o Haiku 4.5 dá erro com ele) e sem thinking.
    thinking: { type: 'disabled' },
    executable: 'node',
    tools: [],
    maxTurns: 1,
    includePartialMessages: false,
    permissionMode: 'bypassPermissions',
    persistSession: false,
    // Sem a auto-memória do CLI: a única pasta de memória é a de Configurações.
    settings: { autoMemoryEnabled: false },
    abortController
  }
  let out = ''
  for await (const message of run({ prompt: singlePrompt(text), options })) {
    const m = message as {
      type?: unknown
      error?: unknown
      is_error?: unknown
      message?: { content?: Array<{ type: string; text?: string }> }
    }
    // Erro classificado pelo SDK: o "texto" que vem junto é a mensagem de erro.
    if (m.type === 'assistant' && m.error) return null
    if (m.type === 'result' && m.is_error === true) return null
    if (m.type !== 'assistant') continue
    for (const block of m.message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') out += block.text
    }
  }
  return sanitizeTitle(out)
}

/** Título curto para `text`, ou null (vazio, falha, erro do modelo, tempo esgotado). */
export async function suggestConversationTitle(text: string, deps: TitleDeps = {}): Promise<string | null> {
  const input = String(text ?? '').slice(0, TITLE_INPUT_MAX_CHARS).trim()
  if (!input) return null
  const run = deps.query ?? (query as TitleQuery)
  const abortController = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      abortController.abort()
      resolve(null)
    }, deps.timeoutMs ?? TITLE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([askModel(input, run, abortController), timeout])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
