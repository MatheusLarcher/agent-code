/**
 * Semeia o resumo da conversa (conversationDigest.ts) numa sessão RETOMADA.
 *
 * O resumo vive só na memória do processo: ao reabrir o app, a conversa
 * retomada continua no SDK, mas o Haiku que escolhe as memórias não via nada do
 * que já foi dito. Aqui as mensagens gravadas da sessão viram as mesmas
 * entradas que o envio ao vivo registraria:
 * - do usuário, só o pedido — sem o carimbo, sem os blocos de catálogo, sem as
 *   memórias injetadas e sem as notas do sistema (promptEnvelope.ts);
 * - do assistente principal, só o texto — sem ferramentas, sem pensamento e
 *   sem subagentes.
 *
 * Nunca lança: falha ou sessão sem mensagens deixa o resumo vazio.
 */
import { getSessionMessages, type SessionMessage, type SessionStore } from '@anthropic-ai/claude-agent-sdk'
import { readMemoryBody } from '../memoryIndex'
import type { DigestRole } from './conversationDigest'

export interface SeedEntry {
  role: DigestRole
  text: string
}

/** O corpo atual de uma memória pelo caminho relativo, ou null. */
export type MemoryBodyReader = (relPath: string) => string | null

/** Mesmo formato de buildContextStamp (agentSession.ts): toda mensagem que o
 *  app envia abre com ele. Sem o carimbo não é pedido do usuário (resultado de
 *  ferramenta, resumo de compactação, interrupção). */
const STAMP_RE = /^\[Contexto do sistema: mensagem enviada [^\n]*?\)\.\]/
/** Bloco de contexto `[TAG]\n…[/TAG]` (catálogos, projetos, outras conversas). */
const TAG_OPEN_RE = /^\[([A-Z][A-Z0-9_]*)\]\n/
/** Cabeçalho de memória injetada (memoryContextBlock, memoryIndex.ts). */
const MEMORY_HEAD_RE = /^--- Memória relevante: ([^\n]+?) ---\n/
/** O que pode vir DEPOIS das memórias no envelope (composeUserPrompt). */
const AFTER_MEMORY = ['\n\n--- Memória relevante: ', '\n\n[SKILL_CATALOG_UPDATE]\n', '\n\n[PROJECTS_ON_THIS_MACHINE]\n', '\n\n[OUTRAS_CONVERSAS]\n']

/** Notas que o envio põe ANTES do texto (cancelamento e parada do Scrum Master). */
const LEADING_NOTE_RES = [
  /^\[Scrum Master\] Este envio foi parado às [^\n]*?editando\.(?:\n\n|$)/,
  /^\[Observação do sistema: o usuário CANCELOU[^\]\n]*\](?:\n\n|$)/
]
/** Nota que o envio põe DEPOIS do texto quando a análise da imagem falha. */
const VISION_FAIL_RE = /\n*\[Observação do sistema: não foi possível analisar a\(s\) imagem\(ns\)[\s\S]*?Responda com base apenas no texto acima\.\]$/
const VISION_HEAD = 'Mensagem original do usuário:\n'
const VISION_MID = '\n\nContexto visual extraído:\n[VISUAL_CONTEXT]\n'
const VISION_TAIL = '\n\nAgora responda considerando a análise visual acima.'
const VISION_NO_TEXT = '(sem texto — apenas a(s) imagem(ns) anexada(s))'

/** Depois de um bloco, o envelope segue com "\n\n" ou acaba. */
function afterSeparator(text: string, at: number): number | null {
  if (at === text.length) return at
  return text.startsWith('\n\n', at) ? at + 2 : null
}

/** Pula UM bloco de contexto no início. Devolve o resto, o mesmo texto se não
 *  houver bloco, ou null se o bloco não dá para delimitar com segurança. */
function skipBlock(rest: string, memoryBody: MemoryBodyReader): string | null {
  const tag = TAG_OPEN_RE.exec(rest)
  if (tag) {
    const close = `[/${tag[1]}]`
    const end = rest.indexOf(close, tag[0].length)
    if (end < 0) return rest
    const next = afterSeparator(rest, end + close.length)
    return next === null ? rest : rest.slice(next)
  }
  const head = MEMORY_HEAD_RE.exec(rest)
  if (!head) return rest
  const body = memoryBody(head[1])
  if (body && rest.startsWith(body, head[0].length)) {
    const next = afterSeparator(rest, head[0].length + body.length)
    if (next !== null) return rest.slice(next)
  }
  // A memória mudou desde o envio: corta até o próximo bloco do envelope. Sem
  // nenhum depois, não há como saber onde ela acaba — a mensagem fica de fora,
  // melhor que levar a memória ao resumo como se fosse o pedido.
  const cuts = AFTER_MEMORY.map((mark) => rest.indexOf(mark, head[0].length)).filter((i) => i >= 0)
  return cuts.length ? rest.slice(Math.min(...cuts) + 2) : null
}

function unwrapVision(body: string): string {
  if (!body.startsWith(VISION_HEAD) || !body.endsWith(VISION_TAIL)) return body
  const mid = body.indexOf(VISION_MID, VISION_HEAD.length)
  if (mid < 0) return body
  const original = body.slice(VISION_HEAD.length, mid)
  return original === VISION_NO_TEXT ? '' : original
}

/**
 * O pedido do usuário dentro da mensagem que o app enviou ao SDK, ou null se
 * não for um pedido (sem carimbo) ou se não sobrar texto.
 */
export function userRequestFromPrompt(prompt: string, memoryBody: MemoryBodyReader = () => null): string | null {
  const stamp = STAMP_RE.exec(prompt)
  if (!stamp) return null
  let rest = prompt.slice(stamp[0].length)
  if (!rest.startsWith('\n\n')) return null
  rest = rest.slice(2)
  for (;;) {
    const next = skipBlock(rest, memoryBody)
    if (next === null) return null
    if (next === rest) break
    rest = next
  }
  let body = unwrapVision(rest).replace(VISION_FAIL_RE, '')
  for (let changed = true; changed;) {
    changed = false
    for (const re of LEADING_NOTE_RES) {
      const hit = re.exec(body)
      if (hit) {
        body = body.slice(hit[0].length)
        changed = true
      }
    }
  }
  body = body.trim()
  return body || null
}

interface ContentBlock {
  type?: unknown
  text?: unknown
}

function contentOf(message: unknown): unknown {
  return message && typeof message === 'object' ? (message as { content?: unknown }).content : undefined
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content
    .filter((block: ContentBlock) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: ContentBlock) => block.text as string)
}

/** As entradas do resumo a partir das mensagens gravadas, em ordem. */
export function seedEntriesFromMessages(messages: readonly SessionMessage[], memoryBody?: MemoryBodyReader): SeedEntry[] {
  const out: SeedEntry[] = []
  for (const msg of messages) {
    // Subagente (ou qualquer coisa dentro de uma ferramenta) não é a conversa.
    if (!msg || msg.parent_tool_use_id != null) continue
    const content = contentOf(msg.message)
    if (msg.type === 'user') {
      // Com imagem, o pedido é o bloco de texto que abre com o carimbo; os
      // outros (rótulos `midia:N`, resultados de ferramenta) não são pedido.
      const candidates = typeof content === 'string' ? [content] : textBlocks(content)
      const prompt = candidates.find((text) => STAMP_RE.test(text))
      const request = prompt === undefined ? null : userRequestFromPrompt(prompt, memoryBody)
      if (request) out.push({ role: 'user', text: request })
    } else if (msg.type === 'assistant') {
      const said = textBlocks(content).join('\n').trim()
      if (said) out.push({ role: 'assistant', text: said })
    }
  }
  return out
}

export type SessionMessagesLoader = typeof getSessionMessages

export interface ConversationSeedOptions {
  sessionId: string
  /** Pasta do projeto: onde o SDK guarda a transcrição da sessão. */
  cwd: string
  /** Store remoto da sessão, tentado quando a cópia local não tem nada. */
  sessionStore?: SessionStore
  /** Pasta das memórias, para reconhecer o corpo das injetadas. */
  memoriesDir?: string
  /** Injeção para teste; padrão: getSessionMessages do SDK. */
  loader?: SessionMessagesLoader
}

/** Carrega e converte a conversa gravada. Nunca lança: falha vira []. */
export async function loadConversationSeed(opts: ConversationSeedOptions): Promise<SeedEntry[]> {
  const loader = opts.loader ?? getSessionMessages
  const memoriesDir = opts.memoriesDir
  const memoryBody: MemoryBodyReader = (relPath) => (memoriesDir ? readMemoryBody(memoriesDir, relPath) : null)
  const load = async (sessionStore?: SessionStore): Promise<SessionMessage[]> => {
    try {
      const messages = await loader(opts.sessionId, sessionStore ? { dir: opts.cwd, sessionStore } : { dir: opts.cwd })
      return Array.isArray(messages) ? messages : []
    } catch {
      return []
    }
  }
  // A transcrição local primeiro (é dela que a retomada importa o store); o
  // store, que pode ser remoto e lento, só quando a local não tem nada.
  let messages = await load()
  if (messages.length === 0 && opts.sessionStore) messages = await load(opts.sessionStore)
  try {
    return seedEntriesFromMessages(messages, memoryBody)
  } catch {
    return []
  }
}
