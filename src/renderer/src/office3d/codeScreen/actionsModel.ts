/**
 * O que o agente fez no turno, para o monitor do escritório — PURO (sem React, sem IO).
 *
 *   turnStart(msgs)                 índice onde começa o turno atual: a última
 *                                   mensagem do usuário entre as SCAN_MAX do fim
 *                                   (o mesmo critério de buildTerminal e do chat
 *                                   do monitor); sem nenhuma, o piso da varredura.
 *   buildTurnActions(msgs, opts)    as quatro seções:
 *     changed  Alterados — exatamente buildTabs(msgs) (a conversa, não só o turno).
 *     read     Lidos — Read/NotebookRead do turno atual, um por arquivo, na ordem
 *              da ÚLTIMA leitura (offset/limit dela); arquivo que está em
 *              Alterados não entra; leitura da pasta de memórias vai para memory.
 *     memory   lidas (Read dentro de `memoriesDir`), gravadas (memory_propose) e
 *              enviadas (`memoriesSent`, do snapshot do main).
 *     other    os grupos de outras ações do turno, na ordem fixa de GROUPS.
 *
 * Chamada com erro conta e vem marcada (`error`); sem resultado ainda, `pending`.
 * A trilha de um subagente (parentToolUseId) não entra — como em buildTabs.
 *
 * Modelo que fez: cada ação leva o `model` do seu tool-use (o id lido da
 * resposta, não do seletor); cada arquivo alterado, os modelos das edições da
 * aba, na ordem; `models` junta os do turno na ordem em que apareceram. Evento
 * antigo sem `model` não tem modelo — nada é deduzido. Memória enviada nunca
 * tem modelo: quem a pôs foi o app.
 */
import { baseName } from '../../components/toolDescribe'
import type { UIMessage } from '../../types'
import type { ToolUseMessage } from '../chatPage'
import { buildTabs, SCAN_MAX, writerPath, type CodeTab } from './codeModel'
import { isInside, normalizePath, relativePath } from './pathGuard'

/** Tamanho máximo do resumo do input de uma ação. */
export const SUMMARY_MAX = 80

interface CallState {
  /** Id da chamada (tool-use). */
  id: string
  pending: boolean
  error: boolean
  /** Id do modelo que fez a chamada; ausente quando o evento não diz. */
  model?: string
}

export interface ReadItem extends CallState {
  /** O caminho como veio na ferramenta. */
  path: string
  /** Forma comparável (normalizePath). */
  key: string
  name: string
  tool: string
  /** Leitura parcial: linha inicial / quantidade, como vieram (null = não informado). */
  offset: number | null
  limit: number | null
}

export interface MemoryRead extends ReadItem {
  /** Caminho relativo à pasta de memórias, com barras normais. */
  relPath: string
}

export interface MemorySave extends CallState {
  relPath: string
  /** create | update | retire (como veio; '' se ausente). */
  op: string
}

export interface TurnAction extends CallState {
  /** Nome da ferramenta como veio (ex.: Grep, mcp__browser__browser_click). */
  tool: string
  /** Resumo curto do input (no máximo SUMMARY_MAX caracteres). */
  summary: string
}

export type ActionGroupKind = 'search' | 'command' | 'web' | 'memory-query' | 'delegate'

export interface ActionGroup {
  kind: ActionGroupKind
  label: string
  items: TurnAction[]
  /** Quantas chamadas do grupo terminaram com erro. */
  errors: number
}

/** Uma aba de Alterados com os modelos que fizeram as edições dela. */
export interface ChangedFile extends CodeTab {
  /** Modelos distintos das edições da aba, na ordem; [] sem modelo conhecido. */
  models: string[]
}

export interface TurnActions {
  changed: ChangedFile[]
  read: ReadItem[]
  memory: { read: MemoryRead[]; saved: MemorySave[]; sent: string[] }
  other: ActionGroup[]
  /** Modelos das ações do turno, distintos, na ordem em que apareceram. */
  models: string[]
}

export interface TurnActionsOptions {
  /** Pasta de memórias (Windows ou POSIX; comparação ignora barras e, no Windows, caixa). */
  memoriesDir?: string | null
  /** Nomes das memórias enviadas no turno (snapshot do main: memoriesSent). */
  memoriesSent?: readonly string[] | null
}

/** Rótulos e ordem dos grupos de outras ações. */
export const GROUPS: readonly { kind: ActionGroupKind; label: string }[] = [
  { kind: 'search', label: 'Buscas' },
  { kind: 'command', label: 'Comandos' },
  { kind: 'web', label: 'Web' },
  { kind: 'memory-query', label: 'Consultas de memória' },
  { kind: 'delegate', label: 'Delegou' }
]

/** Ferramentas que escrevem arquivo (as mesmas de buildTabs). */
const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const READERS =new Set(['Read', 'NotebookRead'])

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Ferramenta MCP pelo nome puro ou com prefixo de servidor (`mcp__<servidor>__<nome>`). */
function isMcpTool(name: string, tool: string): boolean {
  return name === tool || (name.startsWith('mcp__') && name.endsWith(`__${tool}`))
}

const isMemorySave = (name: string): boolean => isMcpTool(name, 'memory_propose')

/** Grupo de uma ferramenta que não lê, não escreve e não grava memória (null = fora das seções). */
export function groupOf(name: string): ActionGroupKind | null {
  if (name === 'Grep' || name === 'Glob') return 'search'
  if (name === 'Bash' || name === 'PowerShell') return 'command'
  if (name === 'WebSearch' || name === 'WebFetch' || name.startsWith('mcp__browser__') || name.startsWith('mcp__chrome__')) return 'web'
  if (isMcpTool(name, 'memory_list') || isMcpTool(name, 'memory_status')) return 'memory-query'
  if (name === 'Task' || name === 'Agent') return 'delegate'
  return null
}

/** Uma linha, espaços colapsados, no máximo SUMMARY_MAX caracteres. */
function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > SUMMARY_MAX ? `${one.slice(0, SUMMARY_MAX - 1)}…` : one
}

/** Resumo curto do input de uma ação dos grupos. */
export function summarize(name: string, input: unknown): string {
  const inp = record(input)
  switch (groupOf(name)) {
    case 'search': {
      const where = str(inp.path) || str(inp.glob)
      return clip(where ? `${str(inp.pattern)} em ${where}` : str(inp.pattern))
    }
    case 'command':
      return clip(str(inp.command).trim().split('\n')[0])
    case 'web': {
      const steps = Array.isArray(inp.steps) ? inp.steps : []
      const stepsText = steps.length ? `${steps.length} passos: ${steps.map((s) => str(record(s).action)).filter(Boolean).join(', ')}` : ''
      const tab = typeof inp.tabId === 'number' || typeof inp.tabId === 'string' ? `aba ${inp.tabId}` : ''
      return clip(
        str(inp.query) || str(inp.url) || str(inp.expression) || str(inp.key) || str(inp.action) || stepsText ||
          str(inp.selector) || str(inp.text) || str(inp.element) || str(inp.ref) || str(inp.value) || tab
      )
    }
    case 'memory-query':
      return clip(str(inp.query))
    case 'delegate': {
      const who = str(inp.subagent_type)
      const what = str(inp.description) || str(inp.prompt)
      return clip(who && what ? `${who}: ${what}` : who || what)
    }
    default:
      return ''
  }
}

export function turnStart(msgs: readonly UIMessage[]): number {
  const floor = Math.max(0, msgs.length - SCAN_MAX)
  for (let i = msgs.length - 1; i > floor; i--) if (msgs[i].kind === 'user') return i
  return floor
}

/** O modelo do tool-use, só quando o evento diz (string não vazia). */
const modelOf = (m: ToolUseMessage): string | undefined =>
  typeof m.model === 'string' && m.model.trim() ? m.model : undefined

const stateOf = (m: ToolUseMessage): CallState => {
  const model = modelOf(m)
  return { id: m.id, pending: !m.result, error: !!m.result?.isError, ...(model ? { model } : {}) }
}

/** Acrescenta sem repetir, mantendo a ordem da primeira vez. */
function addOnce(list: string[], value: string | undefined): void {
  if (value && !list.includes(value)) list.push(value)
}

function readOf(m: ToolUseMessage): ReadItem | null {
  const inp = record(m.input)
  const path = str(inp.file_path) || (m.name === 'NotebookRead' ? str(inp.notebook_path) : '')
  if (!path) return null
  return { ...stateOf(m), path, key: normalizePath(path), name: baseName(path), tool: m.name, offset: num(inp.offset), limit: num(inp.limit) }
}

/** Acrescenta mantendo um item por chave, na posição da última ocorrência. */
function pushLast<T extends { key: string }>(list: T[], item: T): void {
  const at = list.findIndex((x) => x.key === item.key)
  if (at >= 0) list.splice(at, 1)
  list.push(item)
}

export function buildTurnActions(msgs: readonly UIMessage[], opts: TurnActionsOptions = {}): TurnActions {
  // Identidade de TODAS as escritas válidas da janela (buildTabs trunca em MAX_TABS)
  // e o modelo de cada chamada, para as abas acharem o de cada edição (`edit.tool`).
  const changedKeys = new Set<string>()
  const callModels = new Map<string, string>()
  for (let i = Math.max(0, msgs.length - SCAN_MAX); i < msgs.length; i++) {
    const m = msgs[i]
    if (m.kind !== 'tool-use' || m.parentToolUseId != null) continue
    const model = modelOf(m)
    if (model) callModels.set(m.id, model)
    if (m.result?.isError) continue
    const p = writerPath(m.name, m.input)
    if (p && WRITERS.has(m.name)) changedKeys.add(normalizePath(p))
  }
  const changed: ChangedFile[] = buildTabs(msgs).map((tab) => {
    const models: string[] = []
    for (const e of tab.edits) addOnce(models, callModels.get(e.tool))
    return { ...tab, models }
  })
  const models: string[] = []
  const memDir = opts.memoriesDir ?? ''
  const reads: ReadItem[] = []
  const memReads: MemoryRead[] = []
  const saved: MemorySave[] = []
  const groups = new Map<ActionGroupKind, TurnAction[]>()

  for (let i = turnStart(msgs); i < msgs.length; i++) {
    const m = msgs[i]
    if (m.kind !== 'tool-use' || m.parentToolUseId != null) continue
    addOnce(models, modelOf(m))
    if (READERS.has(m.name)) {
      const r = readOf(m)
      if (!r) continue
      if (memDir && isInside(r.path, memDir)) pushLast(memReads, { ...r, relPath: relativePath(r.path, memDir) ?? r.name })
      else pushLast(reads, r)
      continue
    }
    if (isMemorySave(m.name)) {
      const inp = record(m.input)
      saved.push({ ...stateOf(m), relPath: str(inp.rel_path), op: str(inp.op) })
      continue
    }
    const kind = groupOf(m.name)
    if (!kind) continue
    const items = groups.get(kind) ?? []
    items.push({ ...stateOf(m), tool: m.name, summary: summarize(m.name, m.input) })
    groups.set(kind, items)
  }

  const sent = [...new Set((opts.memoriesSent ?? []).filter((n) => typeof n === 'string' && n.trim() !== ''))]
  const other = GROUPS.flatMap(({ kind, label }) => {
    const items = groups.get(kind)
    return items ? [{ kind, label, items, errors: items.filter((x) => x.error).length }] : []
  })
  return {
    changed,
    read: reads.filter((r) => !changedKeys.has(r.key)),
    memory: { read: memReads, saved, sent },
    other,
    models
  }
}
