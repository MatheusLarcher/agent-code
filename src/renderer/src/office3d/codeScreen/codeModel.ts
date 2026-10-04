/**
 * O que o editor do monitor mostra, lido do histórico — PURO (sem React).
 *
 *   buildTabs(msgs)      as abas: um arquivo por aba, do toque mais recente ao
 *                        mais antigo (no máximo MAX_TABS), lendo no máximo
 *                        SCAN_MAX mensagens do fim. Só as ferramentas que
 *                        escrevem (Write, Edit, MultiEdit, NotebookEdit) do
 *                        próprio agente; Read e chamada com erro não contam.
 *                        Cada aba traz as edições do ÚLTIMO turno que mexeu no
 *                        arquivo, o status (U = um Write desse turno criou o
 *                        arquivo; M = o resto) e o conteúdo de antes desse turno
 *                        quando o histórico permite saber (`base`: '' = criado
 *                        no turno; um Write anterior + as edições depois dele,
 *                        se todas se aplicam; senão null — desconhecido).
 *   buildTerminal(msgs)  os últimos comandos Bash/PowerShell do turno atual,
 *                        com o estado e o fim da saída, sem códigos ANSI.
 *
 * Turno = do pedido do usuário (`user`) até o próximo; a trilha de um subagente
 * (trackMessages) é um turno só.
 */
import { baseName } from '../../components/toolDescribe'
import type { UIMessage } from '../../types'
import type { ToolUseMessage } from '../chatPage'
import { normalizePath } from './pathGuard'

/** Abas no máximo (as mais recentes). */
export const MAX_TABS = 12
/** Mensagens lidas do fim, no máximo. */
export const SCAN_MAX = 400
/** Comandos no terminal, no máximo (os mais recentes do turno). */
export const TERMINAL_MAX = 4
/** Linhas do fim da saída de cada comando. */
export const OUTPUT_LINES = 3

export type TabEdit =
  | { kind: 'write'; id: string; tool: string; content: string; created: boolean; pending: boolean }
  | { kind: 'edit'; id: string; tool: string; old: string; new: string; all: boolean; pending: boolean }
  | { kind: 'notebook'; id: string; tool: string; source: string; mode: string; pending: boolean }

export interface CodeTab {
  /** O caminho como veio na ferramenta. */
  path: string
  /** Forma comparável (normalizePath): a identidade da aba. */
  key: string
  name: string
  status: 'U' | 'M'
  /** As edições do último turno que mexeu no arquivo, na ordem em que vieram. */
  edits: TabEdit[]
  /** Conteúdo antes desse turno: '' = criado nele; null = desconhecido. */
  base: string | null
  /** Alguma edição ainda sem resultado. */
  pending: boolean
  /** Ferramentas com resultado (quando muda, a leitura do disco é refeita). */
  doneTools: string[]
  /** Muda quando qualquer coisa que a tela desenha da aba muda. */
  sig: string
}

export interface TerminalCommand {
  id: string
  shell: 'bash' | 'pwsh'
  command: string
  pending: boolean
  ok: boolean
  /** As últimas OUTPUT_LINES linhas da saída. */
  output: string[]
  /** Quantas linhas ficaram acima delas. */
  more: number
}

const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELLS = new Set(['Bash', 'PowerShell'])

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** O caminho que a ferramenta escreve ('' se não houver). */
export function writerPath(name: string, input: unknown): string {
  const inp = record(input)
  return str(name === 'NotebookEdit' ? inp.notebook_path : inp.file_path)
}

/** As edições de uma chamada (MultiEdit vira uma por item). */
function editsOf(m: ToolUseMessage): TabEdit[] {
  const inp = record(m.input)
  const pending = !m.result
  switch (m.name) {
    case 'Write':
      return [{ kind: 'write', id: m.id, tool: m.id, content: str(inp.content), created: !!m.result && /created/i.test(m.result.text), pending }]
    case 'Edit':
      return [{ kind: 'edit', id: m.id, tool: m.id, old: str(inp.old_string), new: str(inp.new_string), all: inp.replace_all === true, pending }]
    case 'MultiEdit':
      return (Array.isArray(inp.edits) ? inp.edits : []).map((raw, i) => {
        const e = record(raw)
        return { kind: 'edit' as const, id: `${m.id}#${i}`, tool: m.id, old: str(e.old_string), new: str(e.new_string), all: e.replace_all === true, pending }
      })
    case 'NotebookEdit':
      return [{ kind: 'notebook', id: m.id, tool: m.id, source: str(inp.new_source), mode: str(inp.edit_mode) || 'replace', pending }]
    default:
      return []
  }
}

/**
 * Aplica uma edição a um texto conhecido; null se ela não se aplica (o trecho
 * antigo não está lá). Sem `String.replace`: o `$` do texto novo não é padrão.
 */
export function applyEdit(text: string, e: { old: string; new: string; all: boolean }): string | null {
  if (e.old === '') return text === '' ? e.new : null
  const at = text.indexOf(e.old)
  if (at < 0) return null
  if (e.all) return text.split(e.old).join(e.new)
  return text.slice(0, at) + e.new + text.slice(at + e.old.length)
}

interface Touch {
  turn: number
  edits: TabEdit[]
}

interface FileAcc {
  path: string
  touches: Touch[]
  /** Índice da última mensagem que mexeu no arquivo (a ordem das abas). */
  last: number
}

/** Conteúdo antes do turno `turn`, refeito dos toques anteriores a ele (null: desconhecido). */
function baseBefore(touches: Touch[], turn: number): string | null {
  const first = touches.find((t) => t.turn === turn)?.edits[0]
  if (first?.kind === 'write' && first.created) return ''
  let text: string | null = null
  for (const t of touches) {
    if (t.turn >= turn) break
    for (const e of t.edits) {
      // Um Write concluído diz o arquivo inteiro. Pendente num turno velho (não
      // se sabe se chegou ao disco), célula de notebook ou edição que não se
      // aplica: desconhecido até o próximo Write.
      if (e.kind === 'write' && !e.pending) text = e.content
      else if (e.pending || e.kind !== 'edit' || text === null) text = null
      else text = applyEdit(text, e)
    }
  }
  return text
}

export function buildTabs(msgs: readonly UIMessage[]): CodeTab[] {
  const floor = Math.max(0, msgs.length - SCAN_MAX)
  const files = new Map<string, FileAcc>()
  let turn = 0
  for (let i = floor; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.kind === 'user') {
      turn++
      continue
    }
    if (m.kind !== 'tool-use' || m.parentToolUseId != null || !WRITERS.has(m.name) || m.result?.isError) continue
    const path = writerPath(m.name, m.input)
    if (!path) continue
    const key = normalizePath(path)
    let acc = files.get(key)
    if (!acc) {
      acc = { path, touches: [], last: i }
      files.set(key, acc)
    }
    acc.path = path
    acc.last = i
    const edits = editsOf(m)
    const lastTouch = acc.touches[acc.touches.length - 1]
    if (lastTouch?.turn === turn) lastTouch.edits.push(...edits)
    else acc.touches.push({ turn, edits })
  }
  return [...files.entries()]
    .sort((a, b) => b[1].last - a[1].last)
    .slice(0, MAX_TABS)
    .map(([key, acc]) => {
      const lastTurn = acc.touches[acc.touches.length - 1]
      const edits = lastTurn.edits
      const status = edits.some((e) => e.kind === 'write' && e.created) ? 'U' : 'M'
      const base = baseBefore(acc.touches, lastTurn.turn)
      const doneTools = [...new Set(edits.filter((e) => !e.pending).map((e) => e.tool))]
      const sig = `${key}|${status}|${base === null ? '-' : base.length}|${edits.map((e) => (e.pending ? `${e.id}?` : e.id)).join(',')}`
      return { path: acc.path, key, name: baseName(acc.path), status, edits, base, pending: edits.some((e) => e.pending), doneTools, sig }
    })
}

// ── terminal ────────────────────────────────────────────────────────────────

/** CSI (cores, cursor) e OSC (título, links) do terminal. */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g

/** Saída como o terminal mostraria: sem ANSI, o `\r` de barra de progresso fica com o último pedaço. */
export function cleanOutput(text: string): string[] {
  const lines = text.replace(ANSI, '').split('\n').map((l) => {
    const cr = l.replace(/\r+$/, '').lastIndexOf('\r')
    return (cr >= 0 ? l.slice(cr + 1) : l).replace(/\r/g, '')
  })
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines
}

export function buildTerminal(msgs: readonly UIMessage[]): TerminalCommand[] {
  const floor = Math.max(0, msgs.length - SCAN_MAX)
  let start = msgs.length - 1
  while (start > floor && msgs[start].kind !== 'user') start--
  const out: TerminalCommand[] = []
  for (let i = Math.max(floor, start); i < msgs.length; i++) {
    const m = msgs[i]
    if (m.kind !== 'tool-use' || m.parentToolUseId != null || !SHELLS.has(m.name)) continue
    const lines = m.result ? cleanOutput(m.result.text) : []
    const output = lines.slice(-OUTPUT_LINES)
    out.push({
      id: m.id,
      shell: m.name === 'PowerShell' ? 'pwsh' : 'bash',
      command: str(record(m.input).command).trim(),
      pending: !m.result,
      ok: !!m.result && !m.result.isError,
      output,
      more: lines.length - output.length
    })
  }
  return out.slice(-TERMINAL_MAX)
}
