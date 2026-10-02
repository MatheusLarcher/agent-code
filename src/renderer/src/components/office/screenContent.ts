/**
 * Conteúdo da tela do monitor: descobre a ferramenta atual do personagem e
 * a traduz num modelo simples por tipo (diff, escrita, leitura, terminal,
 * busca). Puro — sem React, sem DOM — para testar cada formato isolado.
 *
 * Ferramenta atual = tool-use mais recente SEM result. Sem nenhuma aberta,
 * cai na mais recente com result (a tela não fica vazia entre uma chamada e
 * outra, e Read/Bash precisam do result para ter o que mostrar).
 */
import type { OfficeFeed } from '../../office/adapter/feed'
import type { LookupInfo } from '../../office/adapter/model'

export interface CurrentTool {
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  /** true enquanto a chamada não tem result. */
  open: boolean
}

export type ScreenModel =
  | { kind: 'diff'; tool: string; path: string; hunks: Array<{ old: string; new: string }> }
  | { kind: 'write'; tool: string; path: string; text: string }
  | { kind: 'read'; tool: string; path: string; text: string }
  | { kind: 'bash'; tool: string; command: string; output: string }
  | { kind: 'grep'; tool: string; pattern: string; path: string; lines: string[] }
  | { kind: 'other'; tool: string; text: string }
  | { kind: 'empty' }

/** Linhas mantidas no fim de saídas longas (terminal, código ao vivo). */
export const TAIL_LINES = 40
const READ_LINES = 30
const GREP_LINES = 12

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Últimas `n` linhas de um texto. */
export function tail(text: string, n = TAIL_LINES): string {
  const lines = text.split('\n')
  return lines.length <= n ? text : lines.slice(-n).join('\n')
}

function head(text: string, n: number): string {
  const lines = text.split('\n')
  return lines.length <= n ? text : lines.slice(0, n).join('\n')
}

/** A ferramenta atual do personagem (principal: mensagens; subagente: trilha). */
export function currentTool(feed: OfficeFeed | null, info: LookupInfo | undefined): CurrentTool | null {
  if (!feed || !info) return null
  if (info.trackId) {
    const track = feed.tracks[info.convId]?.[info.trackId]
    if (!track) return null
    const steps = track.steps
    const open = [...steps].reverse().find((s) => s.endedAt === undefined && s.result === undefined)
    const pick = open ?? steps[steps.length - 1]
    if (!pick) return null
    return { id: pick.id, name: pick.name, input: asRecord(pick.input), result: pick.result, open: pick === open }
  }
  const conv = feed.conversations.find((c) => c.id === info.convId)
  if (!conv) return null
  let fallback: CurrentTool | null = null
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i]
    if (m.kind !== 'tool-use' || m.parentToolUseId) continue
    const t: CurrentTool = { id: m.id, name: m.name, input: asRecord(m.input), result: m.result?.text, open: !m.result }
    if (t.open) return t
    fallback ??= t
  }
  return fallback
}

/** Caminho do arquivo da ferramenta, quando houver. */
export function toolPath(input: Record<string, unknown>): string {
  return str(input.file_path) || str(input.notebook_path) || str(input.path)
}

export function screenModel(tool: CurrentTool | null): ScreenModel {
  if (!tool) return { kind: 'empty' }
  const { name, input } = tool
  const path = toolPath(input)
  switch (name) {
    case 'Edit':
      return { kind: 'diff', tool: name, path, hunks: [{ old: str(input.old_string), new: str(input.new_string) }] }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits.map(asRecord) : []
      return { kind: 'diff', tool: name, path, hunks: edits.map((e) => ({ old: str(e.old_string), new: str(e.new_string) })) }
    }
    case 'Write':
      return { kind: 'write', tool: name, path, text: str(input.content) }
    case 'NotebookEdit':
      return { kind: 'write', tool: name, path, text: str(input.new_source) }
    case 'Read':
      return { kind: 'read', tool: name, path, text: head(tool.result ?? '', READ_LINES) }
    case 'Bash':
      return { kind: 'bash', tool: name, command: str(input.command), output: tail(tool.result ?? '') }
    case 'Grep':
    case 'Glob': {
      const lines = (tool.result ?? '').split('\n').filter((l) => l.trim()).slice(0, GREP_LINES)
      return { kind: 'grep', tool: name, pattern: str(input.pattern), path, lines }
    }
    default: {
      const text = str(input.description) || str(input.prompt) || str(input.url) || JSON.stringify(input)
      return { kind: 'other', tool: name, text: head(text, READ_LINES) }
    }
  }
}
