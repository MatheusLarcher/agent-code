/**
 * Como o chat descreve uma chamada de ferramenta — FONTE ÚNICA do rótulo do
 * cartão (ToolCard) e de tudo que imita o chat (o monitor e as telas do
 * Escritório 3D). Funções sem estado e sem DOM; a linguagem do realce vem do
 * extToLang do CodeBlock (importar daqui traz o módulo do CodeBlock junto).
 *
 *   describeTool(name, input)   verbo + detalhe, no estilo do Claude Code
 *                               ('Bash' + 1ª linha do comando, 'Edit' + arquivo
 *                               com +N −M, 'Skill' + nome da skill…)
 *   toolInputView(name, input)  a entrada legível do cartão aberto (código, diff ou JSON)
 *   toolBadge(name, result)     a pílula: running… / done / error (respondido /
 *                               sem resposta na pergunta ao usuário)
 *   writtenPath(name, input)    o entregável que um Write criou (chip de download)
 *   baseName, lineCount, TOOL_CODE_MAX, TOOL_RESULT_MAX  auxiliares e limites do cartão aberto
 *
 * O Escritório 3D usa os mesmos rótulos no monitor (office3d/chatPage) e o
 * próprio ToolCard na tela focada e na prévia (office3d/ChatTurn).
 */
import { isDownloadableFile } from '@shared/ipc'
import { extToLang } from './CodeBlock'

/** O corpo aberto do cartão mostra até isto da entrada e do resultado. */
export const TOOL_CODE_MAX = 6000
export const TOOL_RESULT_MAX = 2500

export interface ToolInfo {
  /** Action shown in monospace (e.g. "Skill", "Edit", "Read"). */
  verb: string
  /** Secondary detail: skill name or file name. */
  detail: string
  /** True for the Skill tool — rendered with the accent highlight. */
  isSkill: boolean
  /** Added/removed line counts for file edits, else null. */
  stats: { added: number; removed: number } | null
}

/** A human-readable view of a tool's input: a real code block (with newlines
 *  and quotes intact — no escaped \n / \" noise) instead of raw escaped JSON. */
export interface InputView {
  /** Optional small caption above the block (e.g. a Bash command's description). */
  caption: string
  language: string
  code: string
}

export type BadgeKind = 'run' | 'ok' | 'err'

/** A pílula do cartão: a classe (`tool-badge run|ok|err`) e o texto. */
export interface ToolBadge {
  kind: BadgeKind
  text: string
}

/** Resultado de uma chamada, como o chat guarda (UIMessage.result). */
export type ToolResultLike = { isError: boolean; text: string } | null | undefined

const record = (input: unknown): Record<string, unknown> => (input && typeof input === 'object' ? input : {}) as Record<string, unknown>

/** Last path segment of a file path (handles both / and \ separators). */
export function baseName(p: unknown): string {
  if (typeof p !== 'string' || !p) return ''
  return p.split(/[\\/]/).pop() || p
}

/** Number of lines in a string (0 for empty/non-strings). */
export function lineCount(s: unknown): number {
  return typeof s === 'string' && s.length ? s.split('\n').length : 0
}

/** Derive a compact, Claude-Code-style label (and edit stats) for a tool call. */
export function describeTool(name: string, input: unknown): ToolInfo {
  const inp = record(input)
  switch (name) {
    case 'Skill':
      return { verb: 'Skill', detail: String(inp.skill ?? 'skill'), isSkill: true, stats: null }
    case 'Bash': {
      // Show the first line of the command right in the (collapsed) head, so the
      // user can read what ran without expanding.
      const cmd = typeof inp.command === 'string' ? inp.command.trim() : ''
      const firstLine = cmd.split('\n')[0]
      const detail = firstLine.length > 64 ? firstLine.slice(0, 64) + '…' : firstLine
      return { verb: 'Bash', detail, isSkill: false, stats: null }
    }
    case 'Write':
      return { verb: 'Write', detail: baseName(inp.file_path), isSkill: false, stats: { added: lineCount(inp.content), removed: 0 } }
    case 'Edit':
      return {
        verb: 'Edit',
        detail: baseName(inp.file_path),
        isSkill: false,
        stats: { added: lineCount(inp.new_string), removed: lineCount(inp.old_string) }
      }
    case 'MultiEdit': {
      let added = 0
      let removed = 0
      if (Array.isArray(inp.edits)) {
        for (const e of inp.edits as Array<Record<string, unknown>>) {
          added += lineCount(e?.new_string)
          removed += lineCount(e?.old_string)
        }
      }
      return { verb: 'Edit', detail: baseName(inp.file_path), isSkill: false, stats: { added, removed } }
    }
    case 'NotebookEdit':
      return { verb: 'Edit', detail: baseName(inp.notebook_path), isSkill: false, stats: { added: lineCount(inp.new_source), removed: 0 } }
    case 'Read':
      return { verb: 'Read', detail: baseName(inp.file_path), isSkill: false, stats: null }
    case 'AskUserQuestion': {
      const qs = Array.isArray(inp.questions) ? (inp.questions as Array<Record<string, unknown>>) : []
      const first = qs[0]
      return { verb: 'Pergunta', detail: typeof first?.header === 'string' ? first.header : '', isSkill: false, stats: null }
    }
    default:
      return { verb: name.replace(/^mcp__[^_]+__/, ''), detail: '', isSkill: false, stats: null }
  }
}

export function toolInputView(name: string, input: unknown): InputView {
  const inp = record(input)
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (name) {
    case 'Bash':
      return { caption: str(inp.description), language: 'bash', code: str(inp.command) }
    case 'Write':
      return { caption: str(inp.file_path), language: extToLang(str(inp.file_path)), code: str(inp.content) }
    case 'Edit':
    case 'NotebookEdit': {
      const oldS = str(inp.old_string || inp.old_source)
      const newS = str(inp.new_string || inp.new_source)
      const diffLines = [...oldS.split('\n').map((l) => '- ' + l), ...newS.split('\n').map((l) => '+ ' + l)].join('\n')
      return { caption: str(inp.file_path || inp.notebook_path), language: 'diff', code: diffLines }
    }
    case 'MultiEdit': {
      const edits = Array.isArray(inp.edits) ? (inp.edits as Array<Record<string, unknown>>) : []
      const code = edits
        .map((e) => [...str(e?.old_string).split('\n').map((l) => '- ' + l), ...str(e?.new_string).split('\n').map((l) => '+ ' + l)].join('\n'))
        .join('\n\n')
      return { caption: str(inp.file_path), language: 'diff', code }
    }
    default:
      // Anything else: pretty JSON, highlighted as JSON (still far more readable
      // than a one-line escaped blob).
      return { caption: '', language: 'json', code: JSON.stringify(input, null, 2) }
  }
}

/** A pergunta ao usuário que expirou sem resposta (o texto do deny que volta). */
const NO_ANSWER = /não respondeu|tempo|esgotado/i

/**
 * A pílula do cartão. AskUserQuestion has no allow/deny: its answer is fed back
 * as a `deny` message, so its tool-result is flagged is_error — but that's NOT a
 * failure: it reads "respondido" (or "sem resposta"), never red.
 */
export function toolBadge(name: string, result: ToolResultLike): ToolBadge {
  if (!result) return { kind: 'run', text: 'running…' }
  if (name === 'AskUserQuestion') return { kind: 'ok', text: NO_ANSWER.test(result.text) ? 'sem resposta' : 'respondido' }
  return result.isError ? { kind: 'err', text: 'error' } : { kind: 'ok', text: 'done' }
}

/** O cartão fica vermelho (falha de verdade; a pergunta respondida não conta). */
export function toolErrored(name: string, result: ToolResultLike): boolean {
  return !!result?.isError && name !== 'AskUserQuestion'
}

/**
 * Path of a deliverable a `Write` produced (else ''). Only the `Write` tool
 * (file creation, not edits to existing source) and only deliverable extensions
 * (APK, zip, PDF, image…) qualify — so code/config the agent edits never gets a
 * download chip, just the artifacts the user asked to create.
 */
export function writtenPath(name: string, input: unknown): string {
  if (name !== 'Write') return ''
  const p = record(input).file_path
  return typeof p === 'string' && isDownloadableFile(p) ? p : ''
}
