import { createHash } from 'node:crypto'
import type { PromptContext, RequestContext } from '../promptEnvelope'
import { redactMemorySecrets } from '../memoryIndex'
import {
  secretPlaceholder,
  type ContextBlock,
  type ContextBlockKind,
  type ContextBlockSource,
  type ContextUsageSnapshot
} from '../../shared/contextSnapshot'

/**
 * Blocos do contexto entregue ao agente — funções puras. A sessão chama com as
 * MESMAS partes que monta para o SDK; nada aqui decide o que vai ao modelo.
 */

/** Um bloco antes da máscara: o texto cru nunca sai deste módulo. */
export interface RawBlock {
  kind: ContextBlockKind
  label: string
  text: string
}

/** Uma senha do cofre que pode aparecer no contexto. */
export interface SecretValue {
  name: string
  value: string
}

const PROMPT_LABELS: Partial<Record<ContextBlockKind, string>> = {
  stamp: 'Carimbo (data, origem)',
  'memory-catalog': 'Catálogo de memórias',
  'skills-catalog': 'Catálogo de skills',
  projects: 'Projetos desta máquina',
  others: 'Outras conversas',
  reminder: 'Lembrete do modo econômico',
  'cancel-note': 'Nota de cancelamento',
  loop: 'Modo loop',
  'user-request': 'Pedido do usuário'
}

const LOOP_PREFIX = /^\s*\/loop(?:\s+|$)/iu

/**
 * Decompõe `composeUserPrompt(body, parts)` em blocos, na mesma ordem e pelas
 * mesmas regras. `composeFromPromptBlocks` reproduz o texto exato.
 */
export function promptBlocks(body: string, parts: PromptContext, cancelNote?: string): RawBlock[] {
  const blocks: RawBlock[] = []
  const loop = body.match(LOOP_PREFIX)
  let task = body
  if (loop) {
    blocks.push({ kind: 'loop', label: PROMPT_LABELS.loop!, text: '/loop' })
    task = body.slice(loop[0].length)
  }
  const context: Array<[ContextBlockKind, string | undefined]> = [
    ['stamp', parts.stamp],
    ['memory-catalog', parts.memory],
    ['skills-catalog', parts.skills],
    ['projects', parts.projects],
    ['others', parts.others],
    ['reminder', parts.reminder]
  ]
  for (const [kind, text] of context) {
    if (text) blocks.push({ kind, label: PROMPT_LABELS[kind]!, text })
  }
  if (!task) return blocks
  const rest = cancelNote && task.startsWith(cancelNote) ? task.slice(cancelNote.length) : null
  if (cancelNote && rest !== null && (rest === '' || rest.startsWith('\n\n'))) {
    blocks.push({ kind: 'cancel-note', label: PROMPT_LABELS['cancel-note']!, text: cancelNote })
    if (rest) blocks.push({ kind: 'user-request', label: PROMPT_LABELS['user-request']!, text: rest.slice(2) })
  } else {
    blocks.push({ kind: 'user-request', label: PROMPT_LABELS['user-request']!, text: task })
  }
  return blocks
}

const PROMPT_KINDS = new Set<ContextBlockKind>([
  'stamp', 'memory-catalog', 'skills-catalog', 'projects', 'others', 'reminder', 'cancel-note', 'loop', 'user-request'
])

/** O texto da mensagem a partir dos blocos (inverso de `promptBlocks`). */
export function composeFromPromptBlocks(blocks: ReadonlyArray<Pick<RawBlock, 'kind' | 'text'>>): string {
  const own = blocks.filter((block) => PROMPT_KINDS.has(block.kind))
  const loop = own[0]?.kind === 'loop' ? own[0] : null
  const joined = (loop ? own.slice(1) : own).map((block) => block.text).join('\n\n')
  return loop ? `${loop.text} ${joined}` : joined
}

export function imagesBlock(count: number, visionFallback: boolean): RawBlock | null {
  if (count <= 0) return null
  const what = count === 1 ? '1 imagem anexada' : `${count} imagens anexadas`
  return {
    kind: 'images',
    label: 'Imagens',
    text: visionFallback
      ? `${what} — o modelo não vê imagem: foram descritas por outro modelo e mescladas ao pedido.`
      : `${what} (enviadas como blocos de imagem; o conteúdo não é copiado aqui).`
  }
}

/** O `additionalContext` de um hook, separado em docs e trechos de memória.
 *  Juntos com '\n\n' reproduzem `composeRequestContext(parts)`. */
export function hookBlocks(parts: RequestContext): RawBlock[] {
  const blocks: RawBlock[] = []
  if (parts.docs) blocks.push({ kind: 'docs', label: 'Documentação do projeto', text: parts.docs })
  if (parts.memory) blocks.push({ kind: 'memory-excerpts', label: 'Trechos de memória', text: parts.memory })
  return blocks
}

/** Sufixo que liga um bloco de subagente ao tool-use que o abriu. */
export function subagentTag(parentToolUseId: string): string {
  return `[${parentToolUseId}]`
}

export function subagentBlocks(
  parentToolUseId: string,
  subagentType: string,
  instructions: string | undefined,
  request: string
): RawBlock[] {
  const tag = subagentTag(parentToolUseId)
  const blocks: RawBlock[] = []
  if (instructions) {
    blocks.push({ kind: 'subagent-instructions', label: `Instruções — ${subagentType} ${tag}`, text: instructions })
  }
  if (request) blocks.push({ kind: 'subagent-request', label: `Pedido — ${subagentType} ${tag}`, text: request })
  return blocks
}

/** Troca cada valor do cofre pelo marcador e, fora do system prompt, passa o
 *  filtro de segredos das memórias. */
export function maskText(text: string, kind: ContextBlockKind, secrets: ReadonlyArray<SecretValue>): string {
  const longestFirst = [...secrets].filter((s) => s.value.length > 0).sort((a, b) => b.value.length - a.value.length)
  const escaped = longestFirst.map((s) => s.value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  // Uma passagem: valores curtos nunca voltam a varrer o marcador já produzido.
  const out = escaped.length ? text.replace(new RegExp(escaped.join('|'), 'gu'), (value) =>
    secretPlaceholder(longestFirst.find((s) => s.value === value)!.name)) : text
  return kind === 'system-append' ? out : redactMemorySecrets(out)
}

export function finalizeBlock(
  raw: RawBlock,
  source: ContextBlockSource,
  at: number,
  secrets: ReadonlyArray<SecretValue>
): ContextBlock {
  const text = maskText(raw.text, raw.kind, secrets)
  return {
    kind: raw.kind,
    label: maskText(raw.label, raw.kind, secrets),
    source,
    hash: createHash('sha256').update(text, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(text, 'utf8'),
    at,
    text
  }
}

/** Pedido resumido para o seletor de turnos. */
export function summarizeRequest(text: string, secrets: ReadonlyArray<SecretValue>): string {
  const flat = maskText(text, 'user-request', secrets).replace(/\s+/gu, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat
}

// ---------------------------------------------------------------------------
// getContextUsage → ContextUsageSnapshot
// ---------------------------------------------------------------------------

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const list = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : []
const CATEGORY_KINDS = new Set(['used', 'free', 'buffer', 'deferred'])

/** Converte a resposta do SDK. Defensivo: um CLI antigo pode omitir campos. */
export function usageFromSdk(response: unknown, detail: 'summary' | 'full', at: number): ContextUsageSnapshot | null {
  if (!response || typeof response !== 'object') return null
  const r = response as Record<string, unknown>
  if (typeof r.totalTokens !== 'number') return null
  const skills = r.skills && typeof r.skills === 'object' ? (r.skills as Record<string, unknown>).skillFrontmatter : undefined
  const snapshot: ContextUsageSnapshot = {
    detail,
    at,
    totalTokens: num(r.totalTokens),
    maxTokens: num(r.maxTokens),
    percentage: num(r.percentage),
    categories: list(r.categories).map((c) => ({
      name: str(c.name),
      tokens: num(c.tokens),
      kind: (CATEGORY_KINDS.has(str(c.kind)) ? c.kind : c.isDeferred ? 'deferred' : 'used') as ContextUsageSnapshot['categories'][number]['kind']
    }))
  }
  if (typeof r.model === 'string' && r.model) snapshot.model = r.model
  if (Array.isArray(r.memoryFiles)) snapshot.memoryFiles = list(r.memoryFiles).map((m) => ({ path: str(m.path), type: str(m.type), tokens: num(m.tokens) }))
  if (Array.isArray(r.mcpTools)) snapshot.mcpTools = list(r.mcpTools).map((m) => ({ name: str(m.name), serverName: str(m.serverName), tokens: num(m.tokens) }))
  if (Array.isArray(skills)) snapshot.skills = list(skills).map((s) => ({ name: str(s.name), source: str(s.source), tokens: num(s.tokens) }))
  if (Array.isArray(r.agents)) snapshot.agents = list(r.agents).map((a) => ({ agentType: str(a.agentType), source: str(a.source), tokens: num(a.tokens) }))
  if (Array.isArray(r.systemPromptSections)) {
    snapshot.systemPromptSections = list(r.systemPromptSections).map((s) => ({ name: str(s.name), tokens: num(s.tokens) }))
  }
  if (Array.isArray(r.systemTools)) snapshot.systemTools = list(r.systemTools).map((s) => ({ name: str(s.name), tokens: num(s.tokens) }))
  return snapshot
}

/** Rejeita depois de `ms` — a medição nunca pode segurar o fim do turno. */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: sem resposta em ${ms} ms`)), ms)
    timer.unref?.()
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
